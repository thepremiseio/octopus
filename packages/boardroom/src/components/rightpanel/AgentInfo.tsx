import { useEffect, useState } from 'react';
import type { AgentDetail, Schedule } from '../../types/api';
import {
  getAgent,
  getSchedules,
  createSchedule,
  deleteAgent,
  resetBudget,
  updateAgent,
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
  | { kind: 'tool_allowlist' }
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

  async function handleToggleTrusted() {
    const updated = await updateAgent(agentId, {
      cross_branch_trusted: !agent!.cross_branch_trusted,
    });
    setAgent(updated);
  }

  function handleToolAllowlistSubmit(values: Record<string, string>) {
    const raw = values.tools?.trim();
    const allowlist = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    void updateAgent(agentId, { tool_allowlist: allowlist }).then((updated) => {
      setAgent(updated);
    });
    setModal(null);
  }

  async function handleClearAllowlist() {
    const updated = await updateAgent(agentId, { tool_allowlist: null });
    setAgent(updated);
  }

  return (
    <div className={styles.info}>
      <div className={styles.name}>{agent.agent_name}</div>
      <div className={styles.title}>{agent.agent_title}</div>

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
        <span className={styles.rowLabel}>Tokens today</span>
        <span className={styles.rowValue}>{agent.used_tokens_today?.toLocaleString() ?? '0'}</span>
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

      <div className={styles.sectionLabel}>Permissions</div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Cross-branch trusted</span>
        <span
          className={`${styles.rowValue} ${styles.toggleLink}`}
          onClick={() => void handleToggleTrusted()}
        >
          {agent.cross_branch_trusted ? 'yes' : 'no'}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Tool allowlist</span>
        <span className={styles.rowValue}>
          {agent.tool_allowlist
            ? agent.tool_allowlist.length + ' tools'
            : 'all'}
        </span>
      </div>
      {agent.tool_allowlist && (
        <div className={styles.allowlistItems}>
          {agent.tool_allowlist.map((t) => (
            <span key={t} className={styles.allowlistTag}>{t}</span>
          ))}
          <span className={styles.addLink} onClick={() => void handleClearAllowlist()}>clear</span>
        </div>
      )}
      {!agent.tool_allowlist && (
        <span className={styles.addLink} onClick={() => setModal({ kind: 'tool_allowlist' })}>
          + restrict
        </span>
      )}
      {agent.tool_allowlist && (
        <span className={styles.addLink} onClick={() => setModal({ kind: 'tool_allowlist' })}>
          edit
        </span>
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

      {modal?.kind === 'tool_allowlist' && (
        <PromptModal
          title="Tool allowlist"
          fields={[
            {
              key: 'tools',
              label: 'Comma-separated tool names',
              placeholder: 'sharedspace_read, sharedspace_list, request_hitl, task_complete',
              defaultValue: agent.tool_allowlist?.join(', ') ?? '',
            },
          ]}
          submitLabel="Save"
          onSubmit={handleToolAllowlistSubmit}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}
