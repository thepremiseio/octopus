import { create } from 'zustand';
import type { Conversation, ConversationMessage } from '../types/api';
import { on } from '../api/websocket';

interface ChatState {
  activeAgentId: string | null;
  conversations: Record<string, Conversation[]>;
  messages: Record<string, ConversationMessage[]>;
  activeConversationId: Record<string, string | null>;
  unread: Record<string, boolean>;

  setActiveAgent: (agentId: string | null) => void;
  seedConversations: (agentId: string, conversations: Conversation[]) => void;
  seedMessages: (conversationId: string, messages: ConversationMessage[]) => void;
  appendMessage: (conversationId: string, message: ConversationMessage) => void;
  markRead: (agentId: string) => void;
  newConversation: (agentId: string, conversationId: string) => void;
  setActiveConversation: (agentId: string, conversationId: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  activeAgentId: null,
  conversations: {},
  messages: {},
  activeConversationId: {},
  unread: {},

  setActiveAgent: (agentId) => set({ activeAgentId: agentId }),

  seedConversations: (agentId, conversations) =>
    set((state) => {
      const active = conversations.find((c) => c.active);
      return {
        conversations: { ...state.conversations, [agentId]: conversations },
        activeConversationId: active
          ? { ...state.activeConversationId, [agentId]: active.conversation_id }
          : state.activeConversationId,
      };
    }),

  seedMessages: (conversationId, messages) =>
    set((state) => ({
      messages: { ...state.messages, [conversationId]: messages },
    })),

  appendMessage: (conversationId, message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: [...(state.messages[conversationId] ?? []), message],
      },
    })),

  markRead: (agentId) =>
    set((state) => ({
      unread: { ...state.unread, [agentId]: false },
    })),

  newConversation: (agentId, conversationId) =>
    set((state) => ({
      activeConversationId: { ...state.activeConversationId, [agentId]: conversationId },
      messages: { ...state.messages, [conversationId]: [] },
    })),

  setActiveConversation: (agentId, conversationId) =>
    set((state) => ({
      activeConversationId: { ...state.activeConversationId, [agentId]: conversationId },
    })),
}));

// ─── WS subscriptions ───────────────────────────────────────────────────────

export function initChatSubscriptions(): void {
  on('chat.message.received', (payload) => {
    const state = useChatStore.getState();
    state.appendMessage(payload.conversation_id, {
      message_id: payload.message_id,
      role: 'agent',
      content: payload.content,
      ts: Date.now(),
      run_id: payload.run_id,
    });
    // Mark unread if not the active agent
    if (state.activeAgentId !== payload.agent_id) {
      useChatStore.setState((s) => ({
        unread: { ...s.unread, [payload.agent_id]: true },
      }));
    }
  });
}
