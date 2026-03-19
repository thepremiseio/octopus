import { useEffect } from 'react';
import { useQueuesStore } from '../store/queues';
import type { SelectedItem } from '../store/queues';
import { postHitlDecision, releaseCrossBranch, dropCrossBranch } from '../api/rest';
import { useAgentsStore } from '../store/agents';

function isInputFocused(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

interface UseKeyboardOptions {
  onSetMode: (mode: 'queue' | 'chat' | 'sharedspace' | 'cost') => void;
  onOpenCommandPalette: () => void;
  onNewConversation: () => void;
}

export function useKeyboard({ onSetMode, onOpenCommandPalette, onNewConversation }: UseKeyboardOptions) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Ctrl-K: command palette (always active)
      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onOpenCommandPalette();
        return;
      }

      // Ctrl-Shift-N: new conversation
      if (e.key === 'N' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        onNewConversation();
        return;
      }

      // Suppress remaining shortcuts when in input
      if (isInputFocused()) return;

      const state = useQueuesStore.getState();
      const { selectedItem, hitlCards, crossBranchMessages } = state;

      // Escape: return to queue
      if (e.key === 'Escape') {
        onSetMode('queue');
        return;
      }

      // Up/Down: move focus
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const sortedDecision = [...hitlCards]
          .filter((c) => c.card_type !== 'fyi')
          .sort((a, b) => a.created_ts - b.created_ts);
        const sortedCb = [...crossBranchMessages].sort((a, b) => a.arrived_ts - b.arrived_ts);
        const sortedFyi = [...hitlCards]
          .filter((c) => c.card_type === 'fyi')
          .sort((a, b) => a.created_ts - b.created_ts);
        const allItems: SelectedItem[] = [
          ...sortedDecision.map((c): SelectedItem => ({ kind: 'hitl', cardId: c.card_id })),
          ...sortedCb.map((m): SelectedItem => ({ kind: 'crossbranch', messageId: m.message_id })),
          ...sortedFyi.map((c): SelectedItem => ({ kind: 'hitl', cardId: c.card_id })),
        ];
        if (allItems.length === 0) return;

        const currentIdx = allItems.findIndex((item) => {
          if (!selectedItem || !item) return false;
          if (item.kind === 'hitl' && selectedItem.kind === 'hitl') return item.cardId === selectedItem.cardId;
          if (item.kind === 'crossbranch' && selectedItem.kind === 'crossbranch') return item.messageId === selectedItem.messageId;
          return false;
        });

        let nextIdx: number;
        if (currentIdx < 0) {
          nextIdx = 0;
        } else if (e.key === 'ArrowDown') {
          nextIdx = Math.min(currentIdx + 1, allItems.length - 1);
        } else {
          nextIdx = Math.max(currentIdx - 1, 0);
        }
        const next = allItems[nextIdx];
        if (next) state.setSelectedItem(next);
        return;
      }

      // Actions on selected card
      if (!selectedItem) return;

      if (selectedItem.kind === 'hitl') {
        const card = hitlCards.find((c) => c.card_id === selectedItem.cardId);
        if (!card) return;

        // A: approve/resume or acknowledge FYI
        if (e.key === 'a' || e.key === 'A') {
          if (card.card_type === 'approval' || card.card_type === 'circuit_breaker') {
            state.resolveCard(card.card_id);
            useAgentsStore.getState().updateBadge(card.agent_id, -1);
            void postHitlDecision(card.card_id, { resolution: 'approved' });
          } else if (card.card_type === 'fyi') {
            state.resolveCard(card.card_id);
            useAgentsStore.getState().updateBadge(card.agent_id, -1);
            void postHitlDecision(card.card_id, { resolution: 'acknowledged' });
          }
          return;
        }

        // R: reject/terminate
        if (e.key === 'r' || e.key === 'R') {
          if (card.card_type === 'approval' || card.card_type === 'circuit_breaker') {
            state.resolveCard(card.card_id);
            useAgentsStore.getState().updateBadge(card.agent_id, -1);
            void postHitlDecision(card.card_id, { resolution: 'rejected' });
          }
          return;
        }

        // N: note & return (not for circuit_breaker)
        if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey) {
          // This is handled by the card component (focuses textarea)
          return;
        }

        // 1-9: choice card option
        if (card.card_type === 'choice' && card.options) {
          const num = parseInt(e.key, 10);
          if (num >= 1 && num <= card.options.length) {
            state.resolveCard(card.card_id);
            useAgentsStore.getState().updateBadge(card.agent_id, -1);
            void postHitlDecision(card.card_id, {
              resolution: 'option_selected',
              selected_option: num - 1,
            });
          }
          return;
        }
      }

      if (selectedItem.kind === 'crossbranch') {
        const msg = crossBranchMessages.find((m) => m.message_id === selectedItem.messageId);
        if (!msg) return;

        // Space: release
        if (e.key === ' ') {
          e.preventDefault();
          state.releaseCrossBranchMessage(msg.message_id);
          void releaseCrossBranch(msg.message_id);
          return;
        }

        // Delete: drop
        if (e.key === 'Delete') {
          state.dropCrossBranchMessage(msg.message_id);
          void dropCrossBranch(msg.message_id);
          return;
        }
      }
    }

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onSetMode, onOpenCommandPalette, onNewConversation]);
}
