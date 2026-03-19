import { useEffect, useRef } from 'react';
import { useQueuesStore } from '../../store/queues';
import type { SelectedItem } from '../../store/queues';
import { ApprovalCard } from './ApprovalCard';
import { ChoiceCard } from './ChoiceCard';
import { FyiCard } from './FyiCard';
import { CrossBranchCard } from './CrossBranchCard';
import styles from './QueueMode.module.css';

export function QueueMode() {
  const hitlCards = useQueuesStore((s) => s.hitlCards);
  const crossBranchMessages = useQueuesStore((s) => s.crossBranchMessages);
  const selectedItem = useQueuesStore((s) => s.selectedItem);
  const setSelectedItem = useQueuesStore((s) => s.setSelectedItem);

  const decisionCards = [...hitlCards]
    .filter((c) => c.card_type === 'approval' || c.card_type === 'choice' || c.card_type === 'circuit_breaker')
    .sort((a, b) => a.created_ts - b.created_ts);
  const sortedCrossBranch = [...crossBranchMessages].sort((a, b) => a.arrived_ts - b.arrived_ts);
  const fyiCards = [...hitlCards]
    .filter((c) => c.card_type === 'fyi')
    .sort((a, b) => a.created_ts - b.created_ts);

  const isEmpty = decisionCards.length === 0 && sortedCrossBranch.length === 0 && fyiCards.length === 0;

  // Auto-select the first (oldest) item when nothing is selected
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (isEmpty) return;
    if (selectedItem) { didAutoSelect.current = true; return; }
    if (didAutoSelect.current) return;
    const first: SelectedItem | null =
      decisionCards.length > 0 ? { kind: 'hitl', cardId: decisionCards[0]!.card_id } :
      sortedCrossBranch.length > 0 ? { kind: 'crossbranch', messageId: sortedCrossBranch[0]!.message_id } :
      fyiCards.length > 0 ? { kind: 'hitl', cardId: fyiCards[0]!.card_id } : null;
    if (first) {
      didAutoSelect.current = true;
      setSelectedItem(first);
    }
  }, [isEmpty, selectedItem, decisionCards, sortedCrossBranch, fyiCards, setSelectedItem]);

  function isSelected(item: SelectedItem): boolean {
    if (!selectedItem || !item) return false;
    if (selectedItem.kind !== item.kind) return false;
    if (selectedItem.kind === 'hitl' && item.kind === 'hitl') return selectedItem.cardId === item.cardId;
    if (selectedItem.kind === 'crossbranch' && item.kind === 'crossbranch') return selectedItem.messageId === item.messageId;
    return false;
  }

  if (isEmpty) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyCheck}>&#x2714;</span>
        <span>Nothing needs your attention</span>
      </div>
    );
  }

  return (
    <div className={styles.queue}>
      {decisionCards.length > 0 && (
        <>
          <div className={styles.sectionLabel}>
            <span>Decisions needed</span>
            <span className={styles.sectionRule} />
          </div>
          {decisionCards.map((card) => {
            const sel: SelectedItem = { kind: 'hitl', cardId: card.card_id };
            if (card.card_type === 'choice') {
              return (
                <ChoiceCard
                  key={card.card_id}
                  card={card}
                  selected={isSelected(sel)}
                  onSelect={() => setSelectedItem(sel)}
                />
              );
            }
            return (
              <ApprovalCard
                key={card.card_id}
                card={card}
                selected={isSelected(sel)}
                onSelect={() => setSelectedItem(sel)}
              />
            );
          })}
        </>
      )}

      {sortedCrossBranch.length > 0 && (
        <>
          <div className={styles.sectionLabel}>
            <span>Cross-branch messages</span>
            <span className={styles.sectionRule} />
          </div>
          {sortedCrossBranch.map((msg) => {
            const sel: SelectedItem = { kind: 'crossbranch', messageId: msg.message_id };
            return (
              <CrossBranchCard
                key={msg.message_id}
                message={msg}
                selected={isSelected(sel)}
                onSelect={() => setSelectedItem(sel)}
              />
            );
          })}
        </>
      )}

      {fyiCards.length > 0 && (
        <>
          <div className={styles.sectionLabel}>
            <span>For your info</span>
            <span className={styles.sectionRule} />
          </div>
          {fyiCards.map((card) => {
            const sel: SelectedItem = { kind: 'hitl', cardId: card.card_id };
            return (
              <FyiCard
                key={card.card_id}
                card={card}
                selected={isSelected(sel)}
                onSelect={() => setSelectedItem(sel)}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
