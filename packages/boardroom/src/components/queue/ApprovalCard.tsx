import { useMemo, useState } from 'react';
import { marked } from 'marked';
import type { HitlCard } from '../../types/api';
import { postHitlDecision } from '../../api/rest';
import { useQueuesStore } from '../../store/queues';
import { useAgentsStore } from '../../store/agents';
import { formatTs } from '../../utils/format';
import styles from './QueueMode.module.css';

interface ApprovalCardProps {
  card: HitlCard;
  selected: boolean;
  onSelect: () => void;
}

export function ApprovalCard({ card, selected, onSelect }: ApprovalCardProps) {
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const contextHtml = useMemo(
    () => marked.parse(card.context, { async: false, breaks: true }) as string,
    [card.context],
  );

  const isCircuitBreaker = card.card_type === 'circuit_breaker';

  const accentClass = isCircuitBreaker ? styles.accentCircuitBreaker : styles.accentApproval;
  const badgeClass = isCircuitBreaker ? styles.badgeCircuitBreaker : styles.badgeApproval;
  const badgeLabel = isCircuitBreaker ? 'CIRCUIT BREAKER' : 'APPROVAL';

  async function handleDecision(resolution: 'approved' | 'rejected') {
    // Optimistic removal
    useQueuesStore.getState().resolveCard(card.card_id);
    useAgentsStore.getState().updateBadge(card.agent_id, -1);
    try {
      await postHitlDecision(card.card_id, { resolution });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      // Roll back
      useQueuesStore.getState().appendCard(card);
      useAgentsStore.getState().updateBadge(card.agent_id, 1);
    }
  }

  async function handleReturn() {
    if (!note.trim()) return;
    useQueuesStore.getState().resolveCard(card.card_id);
    useAgentsStore.getState().updateBadge(card.agent_id, -1);
    try {
      await postHitlDecision(card.card_id, { resolution: 'returned', note: note.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      useQueuesStore.getState().appendCard(card);
      useAgentsStore.getState().updateBadge(card.agent_id, 1);
    }
  }

  return (
    <div
      className={`${styles.card} ${accentClass} ${selected ? styles.cardSelected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.cardInner}>
        <div className={styles.cardHeader}>
          <span className={`${styles.typeBadge} ${badgeClass}`}>{badgeLabel}</span>
          <span className={styles.agentName}>{card.agent_name}</span>
          <span className={styles.timestamp}>{formatTs(card.created_ts)}</span>
        </div>
        <div className={styles.subject}>{card.subject}</div>
        <div className={`${styles.context} ${styles.markdown}`} dangerouslySetInnerHTML={{ __html: contextHtml }} />
        {error && <div style={{ color: 'var(--red)', fontSize: 'var(--font-size-label)', marginBottom: 4 }}>{error}</div>}
        <div className={styles.actions}>
          <button className={styles.btnApprove} onClick={(e) => { e.stopPropagation(); void handleDecision('approved'); }}>
            {isCircuitBreaker ? 'resume' : 'approve'}
          </button>
          <button className={styles.btnReject} onClick={(e) => { e.stopPropagation(); void handleDecision('rejected'); }}>
            {isCircuitBreaker ? 'terminate' : 'reject'}
          </button>
          {!isCircuitBreaker && (
            <button className={styles.btnNote} onClick={(e) => { e.stopPropagation(); setShowNote(!showNote); }}>
              note &amp; return
            </button>
          )}
        </div>
        {showNote && (
          <>
            <textarea
              className={styles.noteArea}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Write a note..."
              onClick={(e) => e.stopPropagation()}
            />
            <div className={styles.noteActions}>
              <button className={styles.btnApprove} onClick={(e) => { e.stopPropagation(); void handleReturn(); }}>
                send
              </button>
              <button className={styles.btnNote} onClick={(e) => { e.stopPropagation(); setShowNote(false); setNote(''); }}>
                cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
