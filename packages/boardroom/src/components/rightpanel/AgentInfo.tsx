import { useEffect, useState } from 'react';
import type { AgentDetail, Schedule } from '../../types/api';
import {
  getAgent,
  getSchedules,
  createSchedule,
  deleteAgent,
  resetBudget,
} from '../../api/rest';
import { useAgentsStore } from '../../store/agents';
import { PromptModal } from '../common/PromptModal';
import { formatTs } from '../../utils/format';
import styles from './AgentInfo.module.css';

interface AgentInfoProps {
  agentId: string;
  onEditClaudeMd?: (agentId: string) => void;
  onViewBoilerplate?: (agentId: string) => void;
}

type ModalState =
  | { kind: 'schedule' }
  | { kind: 'delete' }
  | null;

export function AgentInfo({ agentId, onEditClaudeMd, onViewBoilerplate }: AgentInfoProps) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [modal, setModal] = useState<ModalState>(null);

  useEffect(() => {
    void getAgent(agentId).then(setAgent);
    void getSchedules(agentId).then((r) => setSchedules(r.schedules));
  }, [agentId]);

  if (!agent) {
    return <div className={styles.loading}>Loading...</div>;
  }

  const budgetExceeded =
    agent.budget_tokens !== null &&
    agent.used_tokens_today !== null &&
    agent.used_tokens_today >= agent.budget_tokens;

  async function handleResetBudget() {
    await resetBudget(agentId);
    const updated = await getAgent(agentId);
    setAgent(updated);
  }

  function handleScheduleSubmit(values: Record<string, string>) {
    const cron = values.cron?.trim();
    const name = values.name?.trim();
    if (!cron || !name) return;
    void createSchedule(agentId, { cron, name }).then(() => {
      getSchedules(agentId).then((r) => setSchedules(r.schedules));
    });
    setModal(null);
  }

  function handleDeleteSubmit() {
    void deleteAgent(agentId).then(() => {
      useAgentsStore.getState().setSelectedAgent(null);
    });
    setModal(null);
  }

  return (
    <div className={styles.info}>
      <div className={styles.name}>{agent.agent_name}</div>

      <div className={styles.sectionLabel}>Status</div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>State</span>
        <span className={styles.rowValue}>{agent.status}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Last run</span>
        <span className={styles.rowValue}>
          {agent.last_run_ts ? formatTs(agent.last_run_ts) : '—'}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Cost today</span>
        <span className={styles.rowValue}>&euro;{agent.cost_today_eur.toFixed(2)}</span>
      </div>
      {agent.budget_tokens !== null && agent.used_tokens_today !== null && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>Daily budget</span>
          <span className={`${styles.rowValue} ${budgetExceeded ? styles.budgetExceeded : ''}`}>
            {agent.used_tokens_today.toLocaleString()} / {agent.budget_tokens.toLocaleString()} tokens
            {budgetExceeded && (
              <span className={styles.resetLink} onClick={() => void handleResetBudget()}>
                Reset
              </span>
            )}
          </span>
        </div>
      )}

      <div className={styles.sectionLabel}>Scheduled Tasks</div>
      {schedules.length === 0 && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>None</span>
        </div>
      )}
      {schedules.map((s) => (
        <div key={s.schedule_id} className={styles.scheduleRow}>
          <span className={styles.schedCron}>{s.cron}</span>
          <span>{s.name}</span>
        </div>
      ))}
      <span className={styles.addLink} onClick={() => setModal({ kind: 'schedule' })}>+ add</span>

      <div className={styles.sectionLabel}>Actions</div>
      <button
        className={styles.actionBtn}
        onClick={() => onEditClaudeMd?.(agentId)}
      >edit CLAUDE.md</button>
      <button
        className={styles.actionBtn}
        onClick={() => onViewBoilerplate?.(agentId)}
      >view boilerplate</button>
      <button
        className={styles.actionBtn}
        onClick={() => setModal({ kind: 'schedule' })}
      >add schedule</button>
      <button
        className={styles.actionBtnDanger}
        onClick={() => setModal({ kind: 'delete' })}
      >delete agent</button>

      {modal?.kind === 'schedule' && (
        <PromptModal
          title="Add scheduled task"
          fields={[
            { key: 'cron', label: 'Cron expression', placeholder: '0 9 * * *' },
            { key: 'name', label: 'Task name', placeholder: 'daily summary' },
          ]}
          submitLabel="Create"
          onSubmit={handleScheduleSubmit}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === 'delete' && (
        <PromptModal
          title="Delete agent"
          confirmMessage={`Delete "${agent.agent_name}" and all its children? This cannot be undone.`}
          danger
          submitLabel="Delete"
          onSubmit={handleDeleteSubmit}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}
