import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import type { ConversationMessage } from '../../types/api';
import { formatTs } from '../../utils/format';
import styles from './MessageThread.module.css';

interface MessageThreadProps {
  messages: ConversationMessage[];
  agentName: string;
}

export function MessageThread({ messages, agentName }: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className={styles.thread}>
      {messages.map((msg) => {
        const isCeo = msg.role === 'ceo';
        return (
          <div
            key={msg.message_id}
            className={`${styles.messageWrapper} ${isCeo ? styles.ceoWrapper : styles.agentWrapper}`}
          >
            <div className={styles.label}>
              {isCeo ? 'you' : agentName} &middot; {formatTs(msg.ts)}
            </div>
            {isCeo ? (
              <div className={`${styles.bubble} ${styles.ceoBubble}`}>
                {msg.content}
              </div>
            ) : (
              <AgentBubble content={msg.content} />
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function AgentBubble({ content }: { content: string }) {
  const html = useMemo(
    () => marked.parse(content, { async: false }) as string,
    [content],
  );
  return (
    <div
      className={`${styles.bubble} ${styles.agentBubble} ${styles.markdown}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
