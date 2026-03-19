import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry, RunSummary } from '../../types/api';
import { getRuns, getRunActivity } from '../../api/rest';
import { on } from '../../api/websocket';
import { formatTs } from '../../utils/format';
import styles from './ActivityFeed.module.css';

interface ActivityFeedProps {
  agentId: string;
  /** Optional run to auto-select (e.g. from a queue card) */
  runId?: string | null;
}

function toolColorClass(category: string): string {
  if (category === 'read') return styles.toolRead!;
  if (category === 'hitl') return styles.toolHitl!;
  return styles.toolDefault!;
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const summary = entry.outcome ?? entry.detail ?? '';
  const fullText = entry.full_detail;
  const hasDetail = !!fullText && fullText !== summary;

  function handleCopy() {
    if (!fullText) return;
    void navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className={styles.entry}>
      <div
        className={`${styles.entryHeader} ${hasDetail ? styles.entryClickable : ''}`}
        onClick={hasDetail ? () => setExpanded((v) => !v) : undefined}
      >
        <span className={styles.entryTs}>{formatTs(entry.ts)}</span>
        <span className={`${styles.toolName} ${toolColorClass(entry.tool_category)}`}>
          {entry.tool_name}
        </span>
        {hasDetail && (
          <span className={styles.expandHint}>{expanded ? '\u25B4' : '\u25BE'}</span>
        )}
      </div>
      {summary && <div className={styles.summary}>{summary}</div>}
      {expanded && fullText && (
        <div className={styles.expandedDetail}>
          <div className={styles.expandedContent}>{fullText}</div>
          <button className={styles.copyBtn} onClick={handleCopy}>
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      )}
    </div>
  );
}

function formatRunLabel(run: RunSummary): string {
  const time = formatTs(run.started_ts);
  const trigger = run.trigger_type;
  const status = run.completed_ts
    ? (run.exit_reason ?? 'done')
    : 'running';
  return `${time} · ${trigger} · ${status}`;
}

export function ActivityFeed({ agentId, runId: externalRunId }: ActivityFeedProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(externalRunId ?? null);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [isLive, setIsLive] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch the 10 latest runs for this agent
  useEffect(() => {
    let cancelled = false;
    void getRuns(agentId, 10).then((r) => {
      if (cancelled) return;
      setRuns(r.runs);
      // Auto-select: external run, or the latest run
      const target = externalRunId && r.runs.some((run) => run.run_id === externalRunId)
        ? externalRunId
        : r.runs[0]?.run_id ?? null;
      setSelectedRunId(target);
    });
    return () => { cancelled = true; };
  }, [agentId, externalRunId]);

  // When a new run starts for this agent, prepend it and auto-select
  useEffect(() => {
    const unsub = on('agent.run.started', (payload) => {
      if (payload.agent_id !== agentId) return;
      const newRun: RunSummary = {
        run_id: payload.run_id,
        trigger_type: payload.trigger_type,
        trigger_detail: payload.trigger_detail ?? null,
        started_ts: Date.now(),
        completed_ts: null,
        exit_reason: null,
        total_tokens: null,
      };
      setRuns((prev) => [newRun, ...prev].slice(0, 10));
      setSelectedRunId(payload.run_id);
    });
    return unsub;
  }, [agentId]);

  // When a run completes, update its status in the list
  useEffect(() => {
    const unsub = on('agent.run.completed', (payload) => {
      if (payload.agent_id !== agentId) return;
      setRuns((prev) =>
        prev.map((r) =>
          r.run_id === payload.run_id
            ? { ...r, completed_ts: Date.now(), exit_reason: payload.exit_reason, total_tokens: payload.total_tokens }
            : r,
        ),
      );
    });
    return unsub;
  }, [agentId]);

  // Fetch activity entries for the selected run
  useEffect(() => {
    if (!selectedRunId) {
      setEntries([]);
      setIsLive(false);
      return;
    }
    let cancelled = false;
    void getRunActivity(agentId, selectedRunId).then((r) => {
      if (cancelled) return;
      setEntries(r.entries);
      setIsLive(r.status === 'active');
    });
    return () => { cancelled = true; };
  }, [agentId, selectedRunId]);

  // Live mode: append from WS
  useEffect(() => {
    if (!isLive || !selectedRunId) return;
    const unsub = on('agent.run.activity', (payload) => {
      if (payload.run_id !== selectedRunId) return;
      setEntries((prev) => [
        ...prev,
        {
          entry_id: payload.entry_id,
          entry_type: payload.entry_type,
          tool_name: payload.tool_name,
          tool_category: payload.tool_category,
          detail: payload.detail,
          outcome: payload.outcome,
          full_detail: payload.full_detail ?? null,
          ts: Date.now(),
        },
      ]);
    });
    const unsubComplete = on('agent.run.completed', (payload) => {
      if (payload.run_id === selectedRunId) setIsLive(false);
    });
    return () => { unsub(); unsubComplete(); };
  }, [isLive, selectedRunId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className={styles.feed}>
      {runs.length > 0 && (
        <select
          className={styles.runSelect}
          value={selectedRunId ?? ''}
          onChange={(e) => setSelectedRunId(e.target.value || null)}
        >
          {runs.map((run) => (
            <option key={run.run_id} value={run.run_id}>
              {formatRunLabel(run)}
            </option>
          ))}
        </select>
      )}
      {selectedRunId && isLive && (
        <div className={styles.subheader}>live</div>
      )}
      {!selectedRunId && (
        <div className={styles.subheader}>No runs yet</div>
      )}
      {entries.map((entry, i) => (
        <EntryRow key={`${entry.entry_id}-${entry.entry_type}-${i}`} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
