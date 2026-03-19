import { useMemo, useState } from 'react';
import { marked } from 'marked';
import type { CrossBranchMessage } from '../../types/api';
import { releaseCrossBranch, dropCrossBranch } from '../../api/rest';
import { useQueuesStore } from '../../store/queues';
import { formatTs } from '../../utils/format';
import styles from './QueueMode.module.css';

interface CrossBranchCardProps {
  message: CrossBranchMessage;
  selected: boolean;
  onSelect: () => void;
}

export function CrossBranchCard({ message, selected, onSelect }: CrossBranchCardProps) {
  const [error, setError] = useState<string | null>(null);
  const bodyHtml = useMemo(
    () => marked.parse(message.body, { async: false, breaks: true }) as string,
    [message.body],
  );

  async function handleRelease() {
    useQueuesStore.getState().releaseCrossBranchMessage(message.message_id);
    try {
      await releaseCrossBranch(message.message_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      useQueuesStore.getState().appendCrossBranchMessage(message);
    }
  }

  async function handleDrop() {
    useQueuesStore.getState().dropCrossBranchMessage(message.message_id);
    try {
      await dropCrossBranch(message.message_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      useQueuesStore.getState().appendCrossBranchMessage(message);
    }
  }

  return (
    <div
      className={`${styles.card} ${styles.accentCrossBranch} ${selected ? styles.cardSelected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.cardInner}>
        <div className={styles.cardHeader}>
          <span className={`${styles.typeBadge} ${styles.badgeCrossBranch}`}>CROSS-BRANCH</span>
          <span className={styles.agentName}>{message.from_agent_name}</span>
          <span className={styles.timestamp}>{formatTs(message.arrived_ts)}</span>
        </div>
        <div className={styles.cbRoute}>
          {message.from_agent_path.join(' / ')} &rarr; {message.to_agent_path.join(' / ')}
        </div>
        <div className={styles.subject}>{message.subject}</div>
        <div className={`${styles.cbBody} ${styles.markdown}`} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        {error && <div style={{ color: 'var(--red)', fontSize: 'var(--font-size-label)', marginBottom: 4 }}>{error}</div>}
        <div className={styles.actions}>
          <button className={styles.btnApprove} onClick={(e) => { e.stopPropagation(); void handleRelease(); }}>
            release
          </button>
          <button className={styles.btnReject} onClick={(e) => { e.stopPropagation(); void handleDrop(); }}>
            drop
          </button>
        </div>
      </div>
    </div>
  );
}
