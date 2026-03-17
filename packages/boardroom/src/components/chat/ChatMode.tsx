import { useEffect } from 'react';
import { useChatStore } from '../../store/chat';
import { useAgentsStore } from '../../store/agents';
import { getConversations, getConversation, createConversation, sendMessage } from '../../api/rest';
import { MessageThread } from './MessageThread';
import { ChatInput } from './ChatInput';
import { formatTs } from '../../utils/format';
import styles from './ChatMode.module.css';

export function ChatMode() {
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const messages = useChatStore((s) => s.messages);
  const agents = useAgentsStore((s) => s.agents);

  const agent = agents.find((a) => a.agent_id === activeAgentId);
  const convId = activeAgentId ? activeConversationId[activeAgentId] ?? null : null;
  const convList = activeAgentId ? conversations[activeAgentId] ?? [] : [];
  const messageList = convId ? messages[convId] ?? [] : [];
  const isIdle = agent?.status === 'idle';

  // Load conversations on agent change
  useEffect(() => {
    if (!activeAgentId) return;
    void getConversations(activeAgentId).then((r) => {
      useChatStore.getState().seedConversations(activeAgentId, r.conversations);
    });
    useChatStore.getState().markRead(activeAgentId);
  }, [activeAgentId]);

  // Load messages when conversation changes
  useEffect(() => {
    if (!activeAgentId || !convId) return;
    void getConversation(activeAgentId, convId).then((r) => {
      useChatStore.getState().seedMessages(convId, r.messages);
    });
  }, [activeAgentId, convId]);

  if (!activeAgentId || !agent) {
    return <div className={styles.noAgent}>Select an agent to chat</div>;
  }

  async function handleNewConversation() {
    if (!activeAgentId) return;
    const r = await createConversation(activeAgentId);
    useChatStore.getState().newConversation(activeAgentId, r.conversation_id);
  }

  function handleSelectConversation(conversationId: string) {
    if (!activeAgentId) return;
    useChatStore.getState().setActiveConversation(activeAgentId, conversationId);
  }

  async function handleSend(content: string) {
    if (!activeAgentId || !convId) return;
    const r = await sendMessage(activeAgentId, convId, { content });
    useChatStore.getState().appendMessage(convId, {
      message_id: r.message_id,
      role: 'ceo',
      content: r.content,
      ts: r.ts,
      run_id: null,
    });
  }

  const activeConv = convList.find((c) => c.conversation_id === convId);
  const isReadOnly = activeConv ? !activeConv.active : false;

  return (
    <div className={styles.chat}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.agentLabel}>{agent.agent_name}</span>
          {convList.length > 0 && (
            <select
              className={styles.historySelect}
              value={convId ?? ''}
              onChange={(e) => handleSelectConversation(e.target.value)}
            >
              {convList.map((c) => (
                <option key={c.conversation_id} value={c.conversation_id}>
                  {formatTs(c.started_ts)} — {c.preview || 'New conversation'}
                </option>
              ))}
            </select>
          )}
        </div>
        <button className={styles.newBtn} onClick={() => void handleNewConversation()}>
          + new
        </button>
      </div>
      <MessageThread messages={messageList} agentName={agent.agent_name} />
      <ChatInput disabled={!isIdle || isReadOnly} onSend={(c) => void handleSend(c)} />
    </div>
  );
}
