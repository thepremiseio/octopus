import { useState } from 'react';
import { useAgentsStore } from '../../store/agents';
import { useChatStore } from '../../store/chat';
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
  const unread = useChatStore((s) => s.unread);
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
          const hasUnread = !!unread[agent.agent_id];
          return (
            <div
              key={agent.agent_id}
              className={`${styles.node} ${isActive ? styles.nodeActive : ''}`}
              style={{ paddingLeft: isActive ? 10 + agent.depth * 16 : 12 + agent.depth * 16 }}
              onClick={() => onSelectAgent(agent.agent_id)}
            >
              <div className={styles.nodeLines}>
                <div className={styles.nodeLine1}>
                  <StatusDot status={agent.status} />
                  <span className={`${styles.nodeName} ${hasUnread ? styles.nodeUnread : ''}`} title={agent.agent_name}>{agent.agent_name}</span>
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
                <div className={styles.nodeTitle}>{agent.agent_title}</div>
              </div>
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
            { key: 'name', label: 'Name', placeholder: 'e.g. Marcus' },
            { key: 'title', label: 'Title', placeholder: 'e.g. Research Agent' },
          ]}
          submitLabel="Create"
          onSubmit={(values) => {
            const name = values.name?.trim();
            const title = values.title?.trim();
            if (!name || !title) return;
            if (agents.some((a) => a.agent_name.toLowerCase() === name.toLowerCase())) {
              alert(`An agent named "${name}" already exists. Names must be unique.`);
              return;
            }
            void createAgent({ agent_name: name, agent_title: title, parent_id: selectedAgentId ?? null });
            setShowCreate(false);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </aside>
  );
}
