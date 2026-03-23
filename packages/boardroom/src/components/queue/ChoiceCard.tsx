import { useMemo, useState } from 'react';
import { marked } from 'marked';
import type { HitlCard } from '../../types/api';
import { postHitlDecision } from '../../api/rest';
import { useQueuesStore } from '../../store/queues';
import { useAgentsStore } from '../../store/agents';
import { formatTs } from '../../utils/format';
import styles from './QueueMode.module.css';

interface ChoiceCardProps {
  card: HitlCard;
  selected: boolean;
  onSelect: () => void;
}

export function ChoiceCard({ card, selected, onSelect }: ChoiceCardProps) {
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const contextHtml = useMemo(
    () => marked.parse(card.context, { async: false, breaks: true }) as string,
    [card.context],
  );

  async function handleSelectOption(index: number) {
    useQueuesStore.getState().resolveCard(card.card_id);
    useAgentsStore.getState().updateBadge(card.agent_id, -1);
    try {
      await postHitlDecision(card.card_id, { resolution: 'option_selected', selected_option: index });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
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
      className={`${styles.card} ${styles.accentChoice} ${selected ? styles.cardSelected : ''}`}
      onClick={onSelect}
    >
      <div className={styles.cardInner}>
        <div className={styles.cardHeader}>
          <span className={`${styles.typeBadge} ${styles.badgeChoice}`}>CHOICE</span>
          <span className={styles.agentName}>{card.agent_name} &middot; {card.agent_title}</span>
          <span className={styles.timestamp}>{formatTs(card.created_ts)}</span>
        </div>
        <div className={styles.subject}>{card.subject}</div>
        <div className={`${styles.context} ${styles.markdown}`} dangerouslySetInnerHTML={{ __html: contextHtml }} />
        {card.preference !== null && (
          <div className={styles.context}>
            <span className={styles.preferenceHighlight}>(agent prefers option {card.preference + 1})</span>
          </div>
        )}
        {error && <div style={{ color: 'var(--red)', fontSize: 'var(--font-size-label)', marginBottom: 4 }}>{error}</div>}
        {card.options && (
          <div className={styles.options}>
            {card.options.map((opt, i) => (
              <div
                key={i}
                className={styles.optionRow}
                onClick={(e) => { e.stopPropagation(); void handleSelectOption(i); }}
              >
                <span className={styles.optionKey}>{i + 1}</span>
                <span className={styles.optionText}>{opt}</span>
              </div>
            ))}
          </div>
        )}
        <div className={styles.actions}>
          <button className={styles.btnNote} onClick={(e) => { e.stopPropagation(); setShowNote(!showNote); }}>
            note &amp; return
          </button>
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
