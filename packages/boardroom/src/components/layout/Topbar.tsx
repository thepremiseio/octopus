import { useCostStore } from '../../store/cost';
import type { ConnectionStatus } from '../../api/websocket';
import styles from './Topbar.module.css';

interface TopbarProps {
  connectionStatus: ConnectionStatus;
  onOpenCostOverview: () => void;
}

export function Topbar({ connectionStatus, onOpenCostOverview }: TopbarProps) {
  const totalTokensToday = useCostStore((s) => s.totalTokensToday);

  const dotClass =
    connectionStatus === 'connected'
      ? styles.connected
      : connectionStatus === 'connecting'
        ? styles.connecting
        : styles.disconnected;

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <span className={`${styles.connectionDot} ${dotClass}`} />
        <span className={styles.logo}>&#x25C8; OCTOPUS</span>
      </div>
      <div className={styles.center}>
        Ctrl-K command palette &middot; Esc queue &middot; 1&ndash;9 choice &middot; A approve &middot; R reject
      </div>
      <button className={styles.costButton} onClick={onOpenCostOverview}>
        {totalTokensToday.toLocaleString()} tokens today
      </button>
    </header>
  );
}
