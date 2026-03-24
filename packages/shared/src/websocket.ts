import type { WsEnvelope, WsEventMap, WsEventType } from './types';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

type Listener<T = unknown> = (payload: T, ts: number) => void;

export interface WsClient {
  init(): void;
  destroy(): void;
  send(msg: Record<string, unknown>): void;
  on<K extends WsEventType>(type: K, fn: Listener<WsEventMap[K]>): () => void;
  getConnectionStatus(): ConnectionStatus;
  onConnectionStatus(fn: (s: ConnectionStatus) => void): () => void;
  getVersionError(): boolean;
  onVersionError(fn: (v: boolean) => void): () => void;
}

const EXPECTED_VERSION = 1;

export function createWsClient(url: string): WsClient {
  const listeners = new Map<string, Set<Listener>>();
  let _status: ConnectionStatus = 'disconnected';
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  let _versionError = false;
  const versionErrorListeners = new Set<(v: boolean) => void>();

  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let phase: 'waiting_ready' | 'waiting_state' | 'streaming' = 'waiting_ready';
  let initialized = false;

  function on<K extends WsEventType>(type: K, fn: Listener<WsEventMap[K]>): () => void {
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

  function getConnectionStatus(): ConnectionStatus {
    return _status;
  }

  function onConnectionStatus(fn: (s: ConnectionStatus) => void): () => void {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
  }

  function setStatus(s: ConnectionStatus): void {
    if (_status === s) return;
    _status = s;
    for (const fn of statusListeners) fn(s);
  }

  function getVersionError(): boolean {
    return _versionError;
  }

  function onVersionError(fn: (v: boolean) => void): () => void {
    versionErrorListeners.add(fn);
    return () => versionErrorListeners.delete(fn);
  }

  function setVersionError(v: boolean): void {
    _versionError = v;
    for (const fn of versionErrorListeners) fn(v);
  }

  function reconnectDelay(): number {
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

    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {};
    socket.onmessage = handleMessage;

    socket.onclose = () => {
      if (ws === socket) {
        ws = null;
        setStatus('disconnected');
        scheduleReconnect();
      }
    };

    socket.onerror = () => {};
  }

  function init(): void {
    if (initialized) return;
    initialized = true;
    connect();
  }

  function send(msg: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function destroy(): void {
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

  return {
    init,
    destroy,
    send,
    on,
    getConnectionStatus,
    onConnectionStatus,
    getVersionError,
    onVersionError,
  };
}
