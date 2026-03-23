import { create } from 'zustand';
import type {
  Agent,
  AgentStatus,
  ConnectionStatePayload,
  ExitReason,
} from '../types/api';
import { on } from '../api/websocket';

interface AgentNode extends Agent {
  last_run_id?: string | null;
  last_run_exit_reason?: ExitReason | null;
}

interface AgentsState {
  agents: AgentNode[];
  selectedAgentId: string | null;

  seedFromConnectionState: (payload: ConnectionStatePayload) => void;
  seedFromRestResponse: (agents: Agent[]) => void;
  upsertAgent: (agent: AgentNode) => void;
  removeSubtree: (deletedIds: string[]) => void;
  updateStatus: (agentId: string, status: AgentStatus) => void;
  updateBadge: (agentId: string, delta: number) => void;
  updateCost: (agentId: string, costTodayEur: number) => void;
  updateLastRun: (agentId: string, ts: number, runId?: string, exitReason?: ExitReason | null) => void;
  setSelectedAgent: (agentId: string | null) => void;
}

function updateAgent(
  agents: AgentNode[],
  agentId: string,
  fn: (a: AgentNode) => AgentNode,
): AgentNode[] {
  return agents.map((a) => (a.agent_id === agentId ? fn(a) : a));
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  selectedAgentId: null,

  seedFromConnectionState: (payload) =>
    set((state) => ({
      agents: payload.agents.map((a) => {
        const existing = state.agents.find((e) => e.agent_id === a.agent_id);
        return {
          ...a,
          last_run_ts: existing?.last_run_ts ?? null,
          last_run_exit_reason: existing?.last_run_exit_reason ?? null,
        };
      }),
    })),

  seedFromRestResponse: (agents) =>
    set({ agents: agents.map((a) => ({ ...a, last_run_exit_reason: null })) }),

  upsertAgent: (agent) =>
    set((state) => {
      const idx = state.agents.findIndex((a) => a.agent_id === agent.agent_id);
      if (idx >= 0) {
        const next = [...state.agents];
        next[idx] = agent;
        return { agents: next };
      }
      // Insert after parent's subtree
      const parentIdx = state.agents.findIndex((a) => a.agent_id === agent.parent_id);
      if (parentIdx < 0) {
        return { agents: [...state.agents, agent] };
      }
      // Find the end of parent's subtree
      let insertIdx = parentIdx + 1;
      const parentDepth = state.agents[parentIdx]!.depth;
      while (insertIdx < state.agents.length && state.agents[insertIdx]!.depth > parentDepth) {
        insertIdx++;
      }
      const next = [...state.agents];
      next.splice(insertIdx, 0, agent);
      return { agents: next };
    }),

  removeSubtree: (deletedIds) =>
    set((state) => {
      const ids = new Set(deletedIds);
      return {
        agents: state.agents.filter((a) => !ids.has(a.agent_id)),
        selectedAgentId: state.selectedAgentId && ids.has(state.selectedAgentId)
          ? null
          : state.selectedAgentId,
      };
    }),

  updateStatus: (agentId, status) =>
    set((state) => ({
      agents: updateAgent(state.agents, agentId, (a) => ({ ...a, status })),
    })),

  updateBadge: (agentId, delta) =>
    set((state) => ({
      agents: updateAgent(state.agents, agentId, (a) => ({
        ...a,
        open_hitl_cards: Math.max(0, a.open_hitl_cards + delta),
      })),
    })),

  updateCost: (agentId, costTodayEur) =>
    set((state) => ({
      agents: updateAgent(state.agents, agentId, (a) => ({
        ...a,
        cost_today_eur: costTodayEur,
      })),
    })),

  updateLastRun: (agentId, ts, runId, exitReason) =>
    set((state) => ({
      agents: updateAgent(state.agents, agentId, (a) => ({
        ...a,
        last_run_ts: ts,
        ...(runId !== undefined ? { last_run_id: runId } : {}),
        ...(exitReason !== undefined ? { last_run_exit_reason: exitReason } : {}),
      })),
    })),

  setSelectedAgent: (agentId) => set({ selectedAgentId: agentId }),
}));

// ─── WS subscriptions ───────────────────────────────────────────────────────

export function initAgentsSubscriptions(): void {
  on('connection.state', (payload) => {
    useAgentsStore.getState().seedFromConnectionState(payload);
  });

  on('agent.status.changed', (payload) => {
    useAgentsStore.getState().updateStatus(payload.agent_id, payload.status);
  });

  on('agent.created', (payload) => {
    useAgentsStore.getState().upsertAgent({
      agent_id: payload.agent_id,
      agent_name: payload.agent_name,
      agent_title: payload.agent_title,
      parent_id: payload.parent_id,
      depth: payload.depth,
      status: payload.status,
      cost_today_eur: payload.cost_today_eur,
      open_hitl_cards: 0,
      last_run_ts: null,
      last_run_exit_reason: null,
    });
  });

  on('agent.deleted', (payload) => {
    useAgentsStore.getState().removeSubtree(payload.deleted_subtree);
  });

  on('agent.run.started', (payload, ts) => {
    useAgentsStore.getState().updateLastRun(payload.agent_id, ts, payload.run_id);
  });

  on('agent.run.completed', (payload, ts) => {
    useAgentsStore.getState().updateLastRun(payload.agent_id, ts, payload.run_id, payload.exit_reason);
  });

  on('cost.updated', (payload) => {
    useAgentsStore.getState().updateCost(payload.agent_id, payload.cost_today_eur);
  });
}
