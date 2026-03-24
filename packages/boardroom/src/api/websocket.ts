import type { WsEnvelope, WsEventMap, WsEventType } from '../types/api';

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${protocol}//${window.location.host}/ws`;
const EXPECTED_VERSION = 1;

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

type Listener<T = unknown> = (payload: T, ts: number) => void;

// ─── Internal event emitter ──────────────────────────────────────────────────

const listeners = new Map<string, Set<Listener>>();

export function on<K extends WsEventType>(
  type: K,
  fn: Listener<WsEventMap[K]>,
): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(fn as Listener);
  return () => {
    set!.delete(fn as Listener);
  };
}

function emit(type: string, payload: unknown, ts: number): void {
  const set = listeners.get(type);
  if (set) {
    for (const fn of set) {
      fn(payload, ts);
    }
  }
}

// ─── Connection status ───────────────────────────────────────────────────────

let _status: ConnectionStatus = 'disconnected';
const statusListeners = new Set<(s: ConnectionStatus) => void>();

export function getConnectionStatus(): ConnectionStatus {
  return _status;
}

export function onConnectionStatus(fn: (s: ConnectionStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function setStatus(s: ConnectionStatus): void {
  if (_status === s) return;
  _status = s;
  for (const fn of statusListeners) fn(s);
}

// ─── Version error ───────────────────────────────────────────────────────────

let _versionError = false;
const versionErrorListeners = new Set<(v: boolean) => void>();

export function getVersionError(): boolean {
  return _versionError;
}

export function onVersionError(fn: (v: boolean) => void): () => void {
  versionErrorListeners.add(fn);
  return () => versionErrorListeners.delete(fn);
}

function setVersionError(v: boolean): void {
  _versionError = v;
  for (const fn of versionErrorListeners) fn(v);
}

// ─── Singleton connection ────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let phase: 'waiting_ready' | 'waiting_state' | 'streaming' = 'waiting_ready';

function reconnectDelay(): number {
  // 1s, 2s, 4s cap
  const delays = [1000, 2000, 4000];
  return delays[Math.min(reconnectAttempt, delays.length - 1)]!;
}

function handleMessage(event: MessageEvent): void {
  let envelope: WsEnvelope;
  try {
    envelope = JSON.parse(event.data as string) as WsEnvelope;
  } catch {
    console.warn('[ws] Failed to parse message');
    return;
  }

  if (phase === 'waiting_ready') {
    if (envelope.type === 'connection.ready') {
      if (envelope.v !== EXPECTED_VERSION) {
        setVersionError(true);
        ws?.close();
        return;
      }
      setVersionError(false);
      phase = 'waiting_state';
      emit('connection.ready', envelope.payload, envelope.ts);
      return;
    }
    console.warn('[ws] Expected connection.ready, got', envelope.type);
    return;
  }

  if (phase === 'waiting_state') {
    if (envelope.type === 'connection.state') {
      phase = 'streaming';
      setStatus('connected');
      reconnectAttempt = 0;
      emit('connection.state', envelope.payload, envelope.ts);
      return;
    }
    console.warn('[ws] Expected connection.state, got', envelope.type);
    return;
  }

  // streaming phase — dispatch domain events
  emit(envelope.type, envelope.payload, envelope.ts);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelay();
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }

  phase = 'waiting_ready';
  setStatus('connecting');

  const socket = new WebSocket(WS_URL);
  ws = socket;

  socket.onopen = () => {
    // Phase transitions happen in handleMessage
  };

  socket.onmessage = handleMessage;

  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      setStatus('disconnected');
      scheduleReconnect();
    }
  };

  socket.onerror = () => {
    // onclose will fire after onerror
  };
}

let initialized = false;

export function init(): void {
  if (initialized) return;
  initialized = true;
  connect();
}

/** Send a JSON message to the server over the WebSocket */
export function send(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function destroy(): void {
  if (!initialized) return;
  initialized = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  setStatus('disconnected');
}
