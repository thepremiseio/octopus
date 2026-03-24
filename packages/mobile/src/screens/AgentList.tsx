import { useAgentsStore } from '../store/agents';
import styles from './AgentList.module.css';

interface Props {
  onSelect(agentId: string, conversationId?: string): void;
}

function formatTime(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;

  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;

  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'active'
      ? 'var(--green)'
      : status === 'alert'
        ? 'var(--amber)'
        : status === 'circuit-breaker'
          ? 'var(--red)'
          : 'var(--text-tertiary)';

  return (
    <span
      className={`${styles.dot} ${status === 'active' ? styles.dotActive : ''}`}
      style={{ background: color }}
    />
  );
}

export function AgentList({ onSelect }: Props) {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);

  // Sort: agents with recent messages first, then alphabetically
  const sorted = [...agents].sort((a, b) => {
    if (a.lastMessageTs && b.lastMessageTs) return b.lastMessageTs - a.lastMessageTs;
    if (a.lastMessageTs) return -1;
    if (b.lastMessageTs) return 1;
    return a.agent_name.localeCompare(b.agent_name);
  });

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.title}>Octopus</h1>
        </div>
        <div className={styles.loading}>Connecting...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Octopus</h1>
        <span className={styles.count}>{agents.length} agents</span>
      </div>
      <div className={styles.list}>
        {sorted.map((agent) => (
          <button
            key={agent.agent_id}
            className={styles.row}
            onClick={() => onSelect(agent.agent_id, agent.activeConversationId)}
          >
            <div className={styles.avatar}>
              <StatusDot status={agent.status} />
              <span className={styles.avatarLetter}>
                {agent.agent_name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className={styles.info}>
              <div className={styles.nameRow}>
                <span className={styles.name}>{agent.agent_name}</span>
                <span className={styles.time}>{formatTime(agent.lastMessageTs)}</span>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.preview}>
                  {agent.lastMessage || agent.agent_title || 'No messages yet'}
                </span>
                {agent.unread > 0 && (
                  <span className={styles.badge}>{agent.unread}</span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
