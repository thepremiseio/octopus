import { create } from 'zustand';
import type { HitlCard, CrossBranchMessage } from '../types/api';
import { on } from '../api/websocket';
import { useAgentsStore } from './agents';

export type SelectedItem =
  | { kind: 'hitl'; cardId: string }
  | { kind: 'crossbranch'; messageId: string }
  | null;

interface QueuesState {
  hitlCards: HitlCard[];
  crossBranchMessages: CrossBranchMessage[];
  selectedItem: SelectedItem;

  seedHitlCards: (cards: HitlCard[]) => void;
  appendCard: (card: HitlCard) => void;
  resolveCard: (cardId: string) => void;
  seedCrossBranchMessages: (messages: CrossBranchMessage[]) => void;
  appendCrossBranchMessage: (message: CrossBranchMessage) => void;
  releaseCrossBranchMessage: (messageId: string) => void;
  dropCrossBranchMessage: (messageId: string) => void;
  setSelectedItem: (item: SelectedItem) => void;
}

export const useQueuesStore = create<QueuesState>((set) => ({
  hitlCards: [],
  crossBranchMessages: [],
  selectedItem: null,

  seedHitlCards: (cards) => set({ hitlCards: cards }),

  appendCard: (card) =>
    set((state) => ({ hitlCards: [card, ...state.hitlCards] })),

  resolveCard: (cardId) =>
    set((state) => ({
      hitlCards: state.hitlCards.filter((c) => c.card_id !== cardId),
      selectedItem:
        state.selectedItem?.kind === 'hitl' && state.selectedItem.cardId === cardId
          ? null
          : state.selectedItem,
    })),

  seedCrossBranchMessages: (messages) => set({ crossBranchMessages: messages }),

  appendCrossBranchMessage: (message) =>
    set((state) => ({
      crossBranchMessages: [message, ...state.crossBranchMessages],
    })),

  releaseCrossBranchMessage: (messageId) =>
    set((state) => ({
      crossBranchMessages: state.crossBranchMessages.filter((m) => m.message_id !== messageId),
      selectedItem:
        state.selectedItem?.kind === 'crossbranch' && state.selectedItem.messageId === messageId
          ? null
          : state.selectedItem,
    })),

  dropCrossBranchMessage: (messageId) =>
    set((state) => ({
      crossBranchMessages: state.crossBranchMessages.filter((m) => m.message_id !== messageId),
      selectedItem:
        state.selectedItem?.kind === 'crossbranch' && state.selectedItem.messageId === messageId
          ? null
          : state.selectedItem,
    })),

  setSelectedItem: (item) => set({ selectedItem: item }),
}));

// ─── WS subscriptions ───────────────────────────────────────────────────────

export function initQueuesSubscriptions(): void {
  on('hitl.card.created', (payload, ts) => {
    useQueuesStore.getState().appendCard({
      ...payload,
      created_ts: ts,
    });
  });

  on('hitl.card.resolved', (payload) => {
    const { hitlCards } = useQueuesStore.getState();
    const card = hitlCards.find((c) => c.card_id === payload.card_id);
    useQueuesStore.getState().resolveCard(payload.card_id);
    // Decrement badge if the card was still in our local list
    // (avoids double-decrement when optimistic removal already ran)
    if (card) {
      useAgentsStore.getState().updateBadge(payload.agent_id, -1);
    }
  });

  on('crossbranch.message.arrived', (payload, ts) => {
    useQueuesStore.getState().appendCrossBranchMessage({
      ...payload,
      arrived_ts: ts,
    });
  });

  on('crossbranch.message.released', (payload) => {
    useQueuesStore.getState().releaseCrossBranchMessage(payload.message_id);
  });

  on('crossbranch.message.dropped', (payload) => {
    useQueuesStore.getState().dropCrossBranchMessage(payload.message_id);
  });
}
