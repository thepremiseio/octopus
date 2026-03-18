import { useCallback, useEffect, useRef, useState } from 'react';
import type { LlmExchange } from '../../types/api';
import { on, send } from '../../api/websocket';
import { formatTs } from '../../utils/format';
import styles from './DebugPanel.module.css';

interface DebugPanelProps {
  agentId: string;
}

// --- Parsed message types ---

interface ParsedMessage {
  role: string;
  content: string;
  tool_name?: string;
  tool_id?: string;
}

/** Parse a single message object into a ParsedMessage */
function parseOneMessage(m: Record<string, unknown>): ParsedMessage {
  const role = String(m.role ?? 'unknown');
  let content = '';
  let tool_name: string | undefined;
  let tool_id: string | undefined;

  if (typeof m.content === 'string') {
    content = m.content;
  } else if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const block of m.content as Record<string, unknown>[]) {
      if (block.type === 'thinking') continue;
      if (block.type === 'text') {
        parts.push(String(block.text ?? ''));
      } else if (block.type === 'tool_use') {
        tool_name = String(block.name ?? '');
        tool_id = String(block.id ?? '');
        parts.push(`[tool_use] ${tool_name}\n  ${JSON.stringify(block.input ?? {}, null, 2)}`);
      } else if (block.type === 'tool_result') {
        tool_id = String(block.tool_use_id ?? '');
        const resultContent = block.content;
        if (typeof resultContent === 'string') {
          parts.push(resultContent);
        } else if (Array.isArray(resultContent)) {
          for (const rc of resultContent as Record<string, unknown>[]) {
            if (rc.type === 'text') parts.push(String(rc.text ?? ''));
          }
        }
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    content = parts.join('\n');
  } else if (m.content != null) {
    content = JSON.stringify(m.content);
  }

  return { role, content, tool_name, tool_id };
}

/**
 * Extract the NEW user-side messages from an exchange's request body.
 * For exchange 0: the initial user message(s).
 * For exchange N: the tool_result(s) added since the previous exchange.
 * In both cases, it's everything after the last assistant message in the array.
 */
function extractNewTurn(messagesJson: string): ParsedMessage[] {
  try {
    const raw = JSON.parse(messagesJson) as Record<string, unknown>;
    if (!raw.messages || !Array.isArray(raw.messages)) return [];

    const allMessages = raw.messages as Record<string, unknown>[];

    // Find last assistant message — everything after it is the new turn
    let lastAssistantIdx = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i]?.role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }

    const newTurnStart = lastAssistantIdx >= 0 ? lastAssistantIdx + 1 : 0;

    // For the very first exchange (no prior assistant), also extract system prompt
    const result: ParsedMessage[] = [];
    if (lastAssistantIdx < 0) {
      if (typeof raw.system === 'string' && raw.system) {
        result.push({ role: 'system', content: raw.system });
      } else if (Array.isArray(raw.system)) {
        const systemParts = (raw.system as Record<string, unknown>[])
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''));
        if (systemParts.length > 0) {
          result.push({ role: 'system', content: systemParts.join('\n') });
        }
      }
    }

    for (let i = newTurnStart; i < allMessages.length; i++) {
      result.push(parseOneMessage(allMessages[i]!));
    }
    return result;
  } catch {
    return [{ role: 'error', content: messagesJson.slice(0, 2000) }];
  }
}

/** Parse a response into ParsedMessage[] */
function parseResponse(responseJson: string): ParsedMessage[] {
  try {
    const raw = JSON.parse(responseJson) as Record<string, unknown>;
    if (raw.role) return [parseOneMessage(raw)];
    return [{ role: 'info', content: JSON.stringify(raw, null, 2) }];
  } catch {
    return [{ role: 'error', content: responseJson.slice(0, 2000) }];
  }
}

/**
 * Build the incremental conversation from a list of exchanges.
 * Each exchange contributes: its new user messages + its assistant response.
 */
function buildConversation(exchanges: LlmExchange[]): ParsedMessage[] {
  const result: ParsedMessage[] = [];
  for (const ex of exchanges) {
    result.push(...extractNewTurn(ex.messages_json));
    if (ex.response_json) {
      result.push(...parseResponse(ex.response_json));
    }
  }
  return result;
}

/** Build raw JSON for copy/display from all exchanges in a run */
function getRunRawJson(exchanges: LlmExchange[]): string {
  if (exchanges.length === 0) return '{}';
  try {
    const items = exchanges.map((ex, i) => {
      const entry: Record<string, unknown> = {
        exchange: i + 1,
        request: JSON.parse(ex.messages_json),
      };
      if (ex.response_json) {
        try { entry.response = JSON.parse(ex.response_json); }
        catch { entry.response = ex.response_json.slice(0, 5000); }
      }
      return entry;
    });
    return JSON.stringify(items.length === 1 ? items[0] : items, null, 2);
  } catch {
    return exchanges[exchanges.length - 1]?.messages_json ?? '{}';
  }
}

function roleClass(role: string): string {
  switch (role) {
    case 'system': return styles.roleSystem!;
    case 'user': return styles.roleUser!;
    case 'assistant': return styles.roleAssistant!;
    case 'tool': return styles.roleTool!;
    default: return styles.roleUser!;
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case 'system': return 'SYSTEM';
    case 'user': return 'USER';
    case 'assistant': return 'ASSISTANT';
    case 'tool': return 'TOOL RESULT';
    case 'error': return 'ERROR';
    default: return role.toUpperCase();
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// --- Run card ---

function RunCard({ exchanges, index }: { exchanges: LlmExchange[]; index: number }) {
  const [expanded, setExpanded] = useState(true);
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);

  const conversation = expanded && !rawMode ? buildConversation(exchanges) : [];

  const totalIn = exchanges.reduce((sum, ex) => sum + ex.tokens_in, 0);
  const totalOut = exchanges.reduce((sum, ex) => sum + ex.tokens_out, 0);
  const lastTs = exchanges[exchanges.length - 1]?.ts ?? 0;

  return (
    <div className={styles.exchange}>
      <div className={styles.exchangeHeader} onClick={() => setExpanded(!expanded)}>
        <span className={styles.chevron}>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>Run {index + 1}</span>
        <span className={styles.exchangeTs}>
          {exchanges.length} exchange{exchanges.length !== 1 ? 's' : ''} &middot; {formatTs(lastTs)}
        </span>
        <span className={styles.tokenInfo}>
          {totalIn.toLocaleString()} in / {totalOut.toLocaleString()} out
        </span>
      </div>
      {expanded && (
        <div className={styles.exchangeBody}>
          <div className={styles.rawToggle}>
            <button
              className={styles.copyBtn}
              onClick={() => {
                void navigator.clipboard.writeText(getRunRawJson(exchanges)).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              title="Copy raw JSON"
            >
              {copied ? 'copied' : 'copy'}
            </button>
            <button
              className={`${styles.rawBtn} ${rawMode ? styles.rawBtnActive : ''}`}
              onClick={() => setRawMode(!rawMode)}
              title="Toggle raw JSON"
            >
              {'{ }'}
            </button>
          </div>
          {rawMode ? (
            <div className={styles.rawJson}>
              {getRunRawJson(exchanges)}
            </div>
          ) : (
            <>
              {conversation.map((msg, i) => (
                <div key={`msg-${i}`} className={styles.messageBlock}>
                  <div className={`${styles.roleLabel} ${roleClass(msg.role)}`}>
                    {roleLabel(msg.role)}
                    {msg.tool_name && (
                      <span className={styles.toolUseLabel}> {msg.tool_name}</span>
                    )}
                  </div>
                  <div className={styles.messageContent}>
                    {truncate(msg.content, 2000)}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- Group exchanges by run_id ---

interface RunGroup {
  runId: string;
  exchanges: LlmExchange[];
}

function groupByRun(exchanges: LlmExchange[]): RunGroup[] {
  const groups: RunGroup[] = [];
  let current: RunGroup | null = null;

  for (const ex of exchanges) {
    if (!current || current.runId !== ex.run_id) {
      current = { runId: ex.run_id, exchanges: [] };
      groups.push(current);
    }
    current.exchanges.push(ex);
  }

  return groups;
}

// --- Main component ---

export function DebugPanel({ agentId }: DebugPanelProps) {
  const [active, setActive] = useState(false);
  const [exchanges, setExchanges] = useState<LlmExchange[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const startDebug = useCallback(() => {
    setActive(true);
    setExchanges([]);
    send({ type: 'debug.subscribe', agent_id: agentId });
  }, [agentId]);

  const stopDebug = useCallback(() => {
    setActive(false);
    send({ type: 'debug.unsubscribe', agent_id: agentId });
  }, [agentId]);

  useEffect(() => {
    return () => {
      if (activeRef.current) {
        send({ type: 'debug.unsubscribe', agent_id: agentId });
      }
    };
  }, [agentId]);

  useEffect(() => {
    if (!active) return;

    const unsub = on('debug.exchange.recorded', (payload) => {
      if (payload.agent_id !== agentId) return;
      setExchanges((prev) => [
        ...prev,
        {
          run_id: payload.run_id,
          exchange_index: payload.exchange_index,
          messages_json: payload.messages_json,
          response_json: payload.response_json,
          tokens_in: payload.tokens_in,
          tokens_out: payload.tokens_out,
          ts: payload.ts,
        },
      ]);
    });

    return unsub;
  }, [active, agentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [exchanges.length]);

  const runs = groupByRun(exchanges);

  return (
    <div className={styles.debug}>
      <div className={styles.controls}>
        {!active ? (
          <button className={styles.startBtn} onClick={startDebug}>
            start debug
          </button>
        ) : (
          <button className={styles.stopBtn} onClick={stopDebug}>
            stop debug
          </button>
        )}
      </div>

      {active && exchanges.length === 0 && (
        <div className={styles.waiting}>Waiting for next run...</div>
      )}

      <div className={styles.exchanges}>
        {runs.map((run, i) => (
          <RunCard key={run.runId} exchanges={run.exchanges} index={i} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
