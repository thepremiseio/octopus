import { useState } from 'react';
import { useAgentsStore } from '../../store/agents';
import { useCostStore } from '../../store/cost';
import { createAgent } from '../../api/rest';
import { PromptModal } from '../common/PromptModal';
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
  const [showCreate, setShowCreate] = useState(false);

  return (
    <aside className={styles.tree}>
      <div className={styles.header}>
        <span>AGENTS</span>
        <button
          className={styles.addButton}
          title="Create agent (child of selected, or top-level)"
          onClick={() => setShowCreate(true)}
        >+</button>
      </div>
      <div
        className={styles.nodes}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            useAgentsStore.getState().setSelectedAgent(null);
          }
        }}
      >
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

      {showCreate && (
        <PromptModal
          title={selectedAgentId ? 'Create child agent' : 'Create top-level agent'}
          fields={[
            { key: 'name', label: 'Agent name', placeholder: 'e.g. Research Lead' },
          ]}
          submitLabel="Create"
          onSubmit={(values) => {
            const name = values.name?.trim();
            if (!name) return;
            void createAgent({ agent_name: name, parent_id: selectedAgentId ?? null });
            setShowCreate(false);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </aside>
  );
}
