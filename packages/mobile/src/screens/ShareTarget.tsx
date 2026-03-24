import { useAgentsStore } from '../store/agents';
import styles from './ShareTarget.module.css';

interface Props {
  sharedText: string;
  onSelect(agentId: string, text: string): void;
  onCancel(): void;
}

export function ShareTarget({ sharedText, onSelect, onCancel }: Props) {
  const agents = useAgentsStore((s) => s.agents);

  const sorted = [...agents].sort((a, b) => a.agent_name.localeCompare(b.agent_name));

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <h2 className={styles.title}>Share with</h2>
        <div className={styles.spacer} />
      </div>

      <div className={styles.preview}>
        <div className={styles.previewLabel}>Content to share:</div>
        <div className={styles.previewText}>{sharedText}</div>
      </div>

      <div className={styles.list}>
        {sorted.map((agent) => (
          <button
            key={agent.agent_id}
            className={styles.row}
            onClick={() => onSelect(agent.agent_id, sharedText)}
          >
            <div className={styles.avatar}>
              {agent.agent_name.charAt(0).toUpperCase()}
            </div>
            <div className={styles.info}>
              <span className={styles.name}>{agent.agent_name}</span>
              {agent.agent_title && (
                <span className={styles.subtitle}>{agent.agent_title}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
