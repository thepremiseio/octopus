import { useMemo } from 'react';
import { marked } from 'marked';
import type { HitlCard } from '../../types/api';
import { postHitlDecision } from '../../api/rest';
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
  const contextHtml = useMemo(
    () => marked.parse(card.context, { async: false, breaks: true }) as string,
    [card.context],
  );

  function handleAcknowledge(e: React.MouseEvent) {
    e.stopPropagation();
    useQueuesStore.getState().resolveCard(card.card_id);
    useAgentsStore.getState().updateBadge(card.agent_id, -1);
    void postHitlDecision(card.card_id, { resolution: 'acknowledged' }).catch(() => {
      useQueuesStore.getState().appendCard(card);
      useAgentsStore.getState().updateBadge(card.agent_id, 1);
    });
  }

  return (
    <div
      className={`${styles.card} ${styles.accentFyi} ${selected ? styles.cardSelected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.cardInner}>
        <div className={styles.cardHeader}>
          <span className={`${styles.typeBadge} ${styles.badgeFyi}`}>FYI</span>
          <span className={styles.agentName}>{card.agent_name} &middot; {card.agent_title}</span>
          <span className={styles.timestamp}>{formatTs(card.created_ts)}</span>
        </div>
        <div className={styles.subject}>{card.subject}</div>
        <div className={`${styles.context} ${styles.markdown}`} dangerouslySetInnerHTML={{ __html: contextHtml }} />
        <div className={styles.actions}>
          <button className={styles.btnNote} onClick={handleAcknowledge}>
            acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}
