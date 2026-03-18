import { useQueuesStore } from '../../store/queues';
import { useAgentsStore } from '../../store/agents';
import { useChatStore } from '../../store/chat';
import styles from './PrimaryPanel.module.css';

export type PanelMode = 'queue' | 'chat' | 'sharedspace' | 'cost' | 'claudemd' | 'boilerplate';

interface PrimaryPanelProps {
  mode: PanelMode;
  onSetMode: (mode: PanelMode) => void;
  children: React.ReactNode;
}

export function PrimaryPanel({ mode, onSetMode, children }: PrimaryPanelProps) {
  const hitlCount = useQueuesStore((s) => s.hitlCards.length);
  const cbCount = useQueuesStore((s) => s.crossBranchMessages.length);
  const queueBadge = hitlCount + cbCount;

  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const agents = useAgentsStore((s) => s.agents);
  const chatAgent = agents.find((a) => a.agent_id === activeAgentId);
  const chatLabel = chatAgent ? `chat · ${chatAgent.agent_name}` : 'chat';

  return (
    <div className={styles.panel}>
      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${mode === 'queue' ? styles.tabActive : ''}`}
          onClick={() => onSetMode('queue')}
        >
          queue
          {queueBadge > 0 && <span className={styles.badge}>{queueBadge}</span>}
        </button>
        <button
          className={`${styles.tab} ${mode === 'chat' ? styles.tabActive : ''}`}
          onClick={() => onSetMode('chat')}
        >
          {chatLabel}
        </button>
        <button
          className={`${styles.tab} ${mode === 'sharedspace' ? styles.tabActive : ''}`}
          onClick={() => onSetMode('sharedspace')}
        >
          shared space
        </button>
      </div>
      <div className={styles.content}>
        {children}
      </div>
    </div>
  );
}
