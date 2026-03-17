import type { AgentStatus } from '../../types/api';
import styles from './StatusDot.module.css';

const statusClass: Record<AgentStatus, string> = {
  idle: styles.idle!,
  active: styles.active!,
  alert: styles.alert!,
  'circuit-breaker': styles.circuitBreaker!,
};

interface StatusDotProps {
  status: AgentStatus;
}

export function StatusDot({ status }: StatusDotProps) {
  return <span className={`${styles.dot} ${statusClass[status]}`} />;
}
