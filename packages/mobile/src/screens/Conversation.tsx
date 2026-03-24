import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chat';
import { useAgentsStore } from '../store/agents';
import styles from './Conversation.module.css';

interface Props {
  agentId: string;
  conversationId?: string;
  prefill?: string;
  onBack(): void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Conversation({ agentId, conversationId, prefill, onBack }: Props) {
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const sending = useChatStore((s) => s.sending);
  const agentStatus = useChatStore((s) => s.agentStatus);
  const openChat = useChatStore((s) => s.openChat);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const closeChat = useChatStore((s) => s.close);

  const agent = useAgentsStore((s) => s.agents.find((a) => a.agent_id === agentId));
  const clearUnread = useAgentsStore((s) => s.clearUnread);

  const [input, setInput] = useState(prefill ?? '');
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    openChat(agentId, conversationId);
    clearUnread(agentId);
    return () => {
      closeChat();
    };
  }, [agentId, conversationId, openChat, closeChat, clearUnread]);

  // Clear unread when messages arrive while chat is open
  useEffect(() => {
    clearUnread(agentId);
  }, [messages.length, agentId, clearUnread]);

  // Auto-scroll on new messages
  useEffect(() => {
    const el = threadRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const canSend = input.trim().length > 0 && !sending && agentStatus !== 'active';

  function handleSend() {
    if (!canSend) return;
    sendMessage(input.trim());
    setInput('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    // Auto-grow
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  const statusLabel =
    agentStatus === 'active'
      ? 'typing...'
      : agentStatus === 'alert'
        ? 'budget exceeded'
        : agentStatus === 'circuit-breaker'
          ? 'paused'
          : 'online';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onBack} aria-label="Back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className={styles.headerInfo}>
          <span className={styles.headerName}>{agent?.agent_name ?? 'Agent'}</span>
          <span className={`${styles.headerStatus} ${agentStatus === 'active' ? styles.headerStatusActive : ''}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      <div className={styles.thread} ref={threadRef}>
        {loading ? (
          <div className={styles.loadingMsg}>Loading...</div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>{agent?.agent_name}</div>
            <div className={styles.emptySubtitle}>{agent?.agent_title || 'Send a message to start a conversation'}</div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.message_id}
              className={`${styles.bubble} ${msg.role === 'ceo' ? styles.bubbleCeo : styles.bubbleAgent}`}
            >
              <div className={styles.bubbleContent}>{msg.content}</div>
              <span className={styles.bubbleTime}>{formatTime(msg.ts)}</span>
            </div>
          ))
        )}
        {agentStatus === 'active' && !loading && (
          <div className={`${styles.bubble} ${styles.bubbleAgent} ${styles.typing}`}>
            <span className={styles.typingDot} />
            <span className={styles.typingDot} />
            <span className={styles.typingDot} />
          </div>
        )}
      </div>

      <div className={styles.inputBar}>
        <textarea
          ref={inputRef}
          className={styles.input}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={agentStatus === 'active' ? 'Agent is working...' : 'Message'}
          rows={1}
          disabled={agentStatus === 'active'}
        />
        <button
          className={`${styles.sendBtn} ${canSend ? styles.sendBtnActive : ''}`}
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Send"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
