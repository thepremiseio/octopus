import { useAgentsStore } from '../../store/agents';
import { useCostStore } from '../../store/cost';
import { StatusDot } from '../common/StatusDot';
import { Badge } from '../common/Badge';
import styles from './AgentTree.module.css';

interface AgentTreeProps {
  onOpenCostOverview: () => void;
  onSelectAgent: (agentId: string) => void;
}

export function AgentTree({ onOpenCostOverview, onSelectAgent }: AgentTreeProps) {
  const agents = useAgentsStore((s) => s.agents);
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId);
  const totalTodayEur = useCostStore((s) => s.totalTodayEur);

  return (
    <aside className={styles.tree}>
      <div className={styles.header}>
        <span>AGENTS</span>
        <button className={styles.addButton} title="Create agent">+</button>
      </div>
      <div className={styles.nodes}>
        {agents.map((agent) => {
          const isActive = agent.agent_id === selectedAgentId;
          return (
            <div
              key={agent.agent_id}
              className={`${styles.node} ${isActive ? styles.nodeActive : ''}`}
              style={{ paddingLeft: isActive ? 10 + agent.depth * 16 : 12 + agent.depth * 16 }}
              onClick={() => onSelectAgent(agent.agent_id)}
            >
              <StatusDot status={agent.status} />
              <span className={styles.nodeName}>{agent.agent_name}</span>
              <span className={styles.nodeRight}>
                {agent.open_hitl_cards > 0 ? (
                  <Badge count={agent.open_hitl_cards} />
                ) : (
                  <span className={styles.costFigure}>
                    &euro;{agent.cost_today_eur.toFixed(2)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className={styles.footer} onClick={onOpenCostOverview}>
        &euro;{totalTodayEur.toFixed(2)} today
      </div>
    </aside>
  );
}
