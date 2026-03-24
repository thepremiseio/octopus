import { create } from 'zustand';
import type { ConnectionStatePayload } from '../types/api';
import { on } from '../api/websocket';

interface CostState {
  totalTokensToday: number;
  agentTokens: Record<string, number>;

  seedFromConnectionState: (payload: ConnectionStatePayload) => void;
  updateAgentTokens: (agentId: string, usedTokensToday: number, totalTokensToday: number) => void;
}

export const useCostStore = create<CostState>((set) => ({
  totalTokensToday: 0,
  agentTokens: {},

  seedFromConnectionState: (payload) =>
    set({
      totalTokensToday: payload.total_tokens_today,
      agentTokens: Object.fromEntries(
        payload.agents.map((a) => [a.agent_id, a.used_tokens_today]),
      ),
    }),

  updateAgentTokens: (agentId, usedTokensToday, totalTokensToday) =>
    set((state) => ({
      totalTokensToday,
      agentTokens: { ...state.agentTokens, [agentId]: usedTokensToday },
    })),
}));

// ─── WS subscriptions ───────────────────────────────────────────────────────

export function initCostSubscriptions(): void {
  on('connection.state', (payload) => {
    useCostStore.getState().seedFromConnectionState(payload);
  });

  on('cost.updated', (payload) => {
    useCostStore.getState().updateAgentTokens(
      payload.agent_id,
      payload.used_tokens_today,
      payload.total_tokens_today,
    );
  });
}
