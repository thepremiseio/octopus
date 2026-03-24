import { create } from 'zustand';
import type { ConversationMessage, ChatMessageReceivedPayload } from '@octopus/shared';
import { api, ws } from '../api';

interface ChatState {
  messages: ConversationMessage[];
  conversationId: string | null;
  agentId: string | null;
  agentStatus: string | null;
  loading: boolean;
  sending: boolean;

  openChat(agentId: string, conversationId?: string): Promise<void>;
  sendMessage(content: string): Promise<void>;
  close(): void;
}

export const useChatStore = create<ChatState>((set, get) => {
  ws.on('chat.message.received', (payload: ChatMessageReceivedPayload) => {
    const { agentId, conversationId } = get();
    if (payload.agent_id === agentId && payload.conversation_id === conversationId) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            message_id: payload.message_id,
            role: 'agent',
            content: payload.content,
            ts: Date.now(),
            run_id: payload.run_id,
          },
        ],
      }));
    }
  });

  ws.on('agent.status.changed', (payload) => {
    if (payload.agent_id === get().agentId) {
      set({ agentStatus: payload.status });
    }
  });

  return {
    messages: [],
    conversationId: null,
    agentId: null,
    agentStatus: null,
    loading: false,
    sending: false,

    async openChat(agentId, conversationId) {
      set({ loading: true, agentId, messages: [], conversationId: conversationId ?? null });

      try {
        if (conversationId) {
          const conv = await api.getConversation(agentId, conversationId);
          set({ messages: conv.messages, conversationId: conv.conversation_id, loading: false });
        } else {
          // Find or create active conversation
          const res = await api.getConversations(agentId);
          const active = res.conversations.find((c) => c.active);
          if (active) {
            const conv = await api.getConversation(agentId, active.conversation_id);
            set({ messages: conv.messages, conversationId: conv.conversation_id, loading: false });
          } else {
            const conv = await api.createConversation(agentId);
            set({ messages: [], conversationId: conv.conversation_id, loading: false });
          }
        }

        // Get current agent status
        const agent = await api.getAgent(agentId);
        set({ agentStatus: agent.status });
      } catch {
        set({ loading: false });
      }
    },

    async sendMessage(content) {
      const { agentId, conversationId } = get();
      if (!agentId || !conversationId || !content.trim()) return;

      set({ sending: true });

      // Optimistic update
      const optimisticMsg: ConversationMessage = {
        message_id: `temp-${Date.now()}`,
        role: 'ceo',
        content,
        ts: Date.now(),
        run_id: null,
      };
      set((s) => ({ messages: [...s.messages, optimisticMsg] }));

      try {
        const res = await api.sendMessage(agentId, conversationId, { content });
        // Replace optimistic with real
        set((s) => ({
          messages: s.messages.map((m) =>
            m.message_id === optimisticMsg.message_id
              ? { ...m, message_id: res.message_id, ts: res.ts }
              : m,
          ),
          sending: false,
          agentStatus: 'active',
        }));
      } catch {
        // Remove optimistic on failure
        set((s) => ({
          messages: s.messages.filter((m) => m.message_id !== optimisticMsg.message_id),
          sending: false,
        }));
      }
    },

    close() {
      set({ messages: [], conversationId: null, agentId: null, agentStatus: null });
    },
  };
});
