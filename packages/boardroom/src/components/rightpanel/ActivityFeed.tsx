import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry } from '../../types/api';
import { getRunActivity } from '../../api/rest';
import { on } from '../../api/websocket';
import { formatTs } from '../../utils/format';
import styles from './ActivityFeed.module.css';

interface ActivityFeedProps {
  agentId: string;
  runId: string;
}

function toolColorClass(category: string): string {
  if (category === 'read') return styles.toolRead!;
  if (category === 'hitl') return styles.toolHitl!;
  return styles.toolDefault!;
}

export function ActivityFeed({ agentId, runId }: ActivityFeedProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [isLive, setIsLive] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getRunActivity(agentId, runId).then((r) => {
      if (cancelled) return;
      setEntries(r.entries);
      setIsLive(r.status === 'active');
    });
    return () => { cancelled = true; };
  }, [agentId, runId]);

  // Live mode: append from WS
  useEffect(() => {
    if (!isLive) return;
    const unsub = on('agent.run.activity', (payload) => {
      if (payload.run_id !== runId) return;
      setEntries((prev) => [
        ...prev,
        {
          entry_id: payload.entry_id,
          entry_type: payload.entry_type,
          tool_name: payload.tool_name,
          tool_category: payload.tool_category,
          detail: payload.detail,
          outcome: payload.outcome,
          ts: Date.now(),
        },
      ]);
    });
    const unsubComplete = on('agent.run.completed', (payload) => {
      if (payload.run_id === runId) setIsLive(false);
    });
    return () => { unsub(); unsubComplete(); };
  }, [isLive, runId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className={styles.feed}>
      <div className={styles.subheader}>
        {agentId} &middot; {runId} {isLive && '(live)'}
      </div>
      {entries.map((entry, i) => (
        <div key={`${entry.entry_id}-${entry.entry_type}-${i}`} className={styles.entry}>
          <span className={styles.entryTs}>{formatTs(entry.ts)}</span>
          <span className={`${styles.toolName} ${toolColorClass(entry.tool_category)}`}>
            {entry.tool_name}
          </span>
          <span className={styles.detail}>
            {entry.outcome ?? entry.detail}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
