import { useEffect, useState } from 'react';
import { getBoilerplate } from '../../api/rest';
import { useAgentsStore } from '../../store/agents';
import styles from './BoilerplateViewer.module.css';

interface BoilerplateViewerProps {
  agentId: string;
  onClose: () => void;
}

export function BoilerplateViewer({ agentId, onClose }: BoilerplateViewerProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  const agents = useAgentsStore((s) => s.agents);
  const agent = agents.find((a) => a.agent_id === agentId);
  const agentName = agent?.agent_name ?? agentId;

  useEffect(() => {
    setLoading(true);
    void getBoilerplate(agentId).then((r) => {
      setContent(r.content);
      setLoading(false);
    });
  }, [agentId]);

  if (loading) {
    return <div className={styles.loading}>Loading boilerplate...</div>;
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>Boilerplate</span>
          <span className={styles.agentLabel}>{agentName}</span>
          <span className={styles.readOnly}>read-only</span>
        </div>
        <button className={styles.closeBtn} onClick={onClose}>close</button>
      </div>
      <pre className={styles.content}>{content || '(empty)'}</pre>
    </div>
  );
}
