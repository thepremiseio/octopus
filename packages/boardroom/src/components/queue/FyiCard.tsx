import { useEffect, useRef } from 'react';
import type { HitlCard } from '../../types/api';
import { useQueuesStore } from '../../store/queues';
import { useAgentsStore } from '../../store/agents';
import { formatTs } from '../../utils/format';
import styles from './QueueMode.module.css';

interface FyiCardProps {
  card: HitlCard;
  selected: boolean;
  onSelect: () => void;
}

export function FyiCard({ card, selected, onSelect }: FyiCardProps) {
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss 5 seconds after selection
  useEffect(() => {
    if (selected) {
      dismissTimerRef.current = setTimeout(() => {
        useQueuesStore.getState().resolveCard(card.card_id);
        useAgentsStore.getState().updateBadge(card.agent_id, -1);
      }, 5000);
    }
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [selected, card.card_id, card.agent_id]);

  function handleAcknowledge(e: React.MouseEvent) {
    e.stopPropagation();
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    useQueuesStore.getState().resolveCard(card.card_id);
    useAgentsStore.getState().updateBadge(card.agent_id, -1);
  }

  return (
    <div
      className={`${styles.card} ${styles.accentFyi} ${selected ? styles.cardSelected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.cardInner}>
        <div className={styles.cardHeader}>
          <span className={`${styles.typeBadge} ${styles.badgeFyi}`}>FYI</span>
          <span className={styles.agentName}>{card.agent_name}</span>
          <span className={styles.timestamp}>{formatTs(card.created_ts)}</span>
        </div>
        <div className={styles.subject}>{card.subject}</div>
        <div className={styles.context}>{card.context}</div>
        <div className={styles.actions}>
          <button className={styles.btnNote} onClick={handleAcknowledge}>
            acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}
