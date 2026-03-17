import { useEffect, useState } from 'react';
import type { AgentDetail, Schedule } from '../../types/api';
import { getAgent, getSchedules, resetBudget } from '../../api/rest';
import { formatTs } from '../../utils/format';
import styles from './AgentInfo.module.css';

interface AgentInfoProps {
  agentId: string;
}

export function AgentInfo({ agentId }: AgentInfoProps) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);

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
      <span className={styles.addLink}>+ add</span>

      <div className={styles.sectionLabel}>Actions</div>
      <button className={styles.actionBtn}>edit CLAUDE.md</button>
      <button className={styles.actionBtn}>view boilerplate</button>
      <button className={styles.actionBtn}>view SharedSpace index</button>
      <button className={styles.actionBtn}>add schedule</button>
      <button className={styles.actionBtnDanger}>delete agent</button>
    </div>
  );
}
