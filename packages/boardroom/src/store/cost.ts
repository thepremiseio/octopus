import { create } from 'zustand';
import type { ConnectionStatePayload } from '../types/api';
import { on } from '../api/websocket';

interface CostState {
  totalTodayEur: number;
  agentCosts: Record<string, number>;

  seedFromConnectionState: (payload: ConnectionStatePayload) => void;
  updateAgentCost: (agentId: string, costTodayEur: number, totalTodayEur: number) => void;
}

export const useCostStore = create<CostState>((set) => ({
  totalTodayEur: 0,
  agentCosts: {},

  seedFromConnectionState: (payload) =>
    set({
      totalTodayEur: payload.total_today_eur,
      agentCosts: Object.fromEntries(
        payload.agents.map((a) => [a.agent_id, a.cost_today_eur]),
      ),
    }),

  updateAgentCost: (agentId, costTodayEur, totalTodayEur) =>
    set((state) => ({
      totalTodayEur,
      agentCosts: { ...state.agentCosts, [agentId]: costTodayEur },
    })),
}));

// ─── WS subscriptions ───────────────────────────────────────────────────────

export function initCostSubscriptions(): void {
  on('connection.state', (payload) => {
    useCostStore.getState().seedFromConnectionState(payload);
  });

  on('cost.updated', (payload) => {
    useCostStore.getState().updateAgentCost(
      payload.agent_id,
      payload.cost_today_eur,
      payload.total_today_eur,
    );
  });
}
