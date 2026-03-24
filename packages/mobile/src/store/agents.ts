import { create } from 'zustand';
import type {
  Agent,
  AgentStatus,
  Conversation,
  ConnectionStatePayload,
  AgentCreatedPayload,
  AgentDeletedPayload,
  AgentStatusChangedPayload,
  ChatMessageReceivedPayload,
} from '@octopus/shared';
import { api, ws } from '../api';

interface AgentWithChat extends Agent {
  lastMessage?: string;
  lastMessageTs?: number;
  unread: number;
  activeConversationId?: string;
}

interface AgentsState {
  agents: AgentWithChat[];
  loading: boolean;
  seed(payload: ConnectionStatePayload): void;
  loadConversations(): Promise<void>;
  markRead(agentId: string): void;
  clearUnread(agentId: string): void;
}

export const useAgentsStore = create<AgentsState>((set, get) => {
  // Subscribe to WebSocket events
  ws.on('connection.state', (payload) => {
    get().seed(payload);
    // Load conversations after seeding
    get().loadConversations();
  });

  ws.on('agent.status.changed', (payload: AgentStatusChangedPayload) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.agent_id === payload.agent_id ? { ...a, status: payload.status as AgentStatus } : a,
      ),
    }));
  });

  ws.on('agent.created', (payload: AgentCreatedPayload) => {
    set((s) => ({
      agents: [
        ...s.agents,
        {
          agent_id: payload.agent_id,
          agent_name: payload.agent_name,
          agent_title: payload.agent_title,
          parent_id: payload.parent_id,
          depth: payload.depth,
          status: payload.status,
          used_tokens_today: payload.used_tokens_today,
          open_hitl_cards: 0,
          last_run_ts: null,
          cross_branch_trusted: payload.cross_branch_trusted,
          tool_allowlist: payload.tool_allowlist,
          unread: 0,
        },
      ],
    }));
  });

  ws.on('agent.deleted', (payload: AgentDeletedPayload) => {
    set((s) => ({
      agents: s.agents.filter((a) => !payload.deleted_subtree.includes(a.agent_id)),
    }));
  });

  ws.on('chat.message.received', (payload: ChatMessageReceivedPayload) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.agent_id === payload.agent_id
          ? {
              ...a,
              lastMessage: payload.content,
              lastMessageTs: Date.now(),
              activeConversationId: payload.conversation_id,
              unread: a.unread + 1,
            }
          : a,
      ),
    }));
  });

  return {
    agents: [],
    loading: true,

    seed(payload) {
      set({
        agents: payload.agents.map((a) => ({
          ...a,
          last_run_ts: null,
          unread: 0,
        })),
        loading: false,
      });
    },

    async loadConversations() {
      const { agents } = get();
      const updates = await Promise.allSettled(
        agents.map(async (agent) => {
          const res = await api.getConversations(agent.agent_id);
          const active = res.conversations.find((c: Conversation) => c.active);
          return {
            agentId: agent.agent_id,
            preview: active?.preview,
            lastTs: active?.last_message_ts ?? undefined,
            conversationId: active?.conversation_id,
          };
        }),
      );

      set((s) => ({
        agents: s.agents.map((a) => {
          const result = updates.find(
            (u) => u.status === 'fulfilled' && u.value.agentId === a.agent_id,
          );
          if (result?.status === 'fulfilled') {
            return {
              ...a,
              lastMessage: result.value.preview ?? a.lastMessage,
              lastMessageTs: result.value.lastTs ?? a.lastMessageTs,
              activeConversationId: result.value.conversationId ?? a.activeConversationId,
            };
          }
          return a;
        }),
      }));
    },

    markRead(agentId) {
      set((s) => ({
        agents: s.agents.map((a) => (a.agent_id === agentId ? { ...a, unread: 0 } : a)),
      }));
    },

    clearUnread(agentId) {
      set((s) => ({
        agents: s.agents.map((a) => (a.agent_id === agentId ? { ...a, unread: 0 } : a)),
      }));
    },
  };
});
