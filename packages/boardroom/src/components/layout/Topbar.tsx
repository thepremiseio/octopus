import { restartServer } from '../../api/rest';
import type { ConnectionStatus } from '../../api/websocket';
import styles from './Topbar.module.css';

interface TopbarProps {
  connectionStatus: ConnectionStatus;
}

export function Topbar({ connectionStatus }: TopbarProps) {
  const dotClass =
    connectionStatus === 'connected'
      ? styles.connected
      : connectionStatus === 'connecting'
        ? styles.connecting
        : styles.disconnected;

  const handleRestart = () => {
    restartServer().catch(() => {
      // Server is shutting down — connection will drop and auto-reconnect
    });
  };

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <span className={`${styles.connectionDot} ${dotClass}`} />
        <span className={styles.logo}>&#x25C8; OCTOPUS</span>
      </div>
      <div className={styles.center}>
        Ctrl-K command palette &middot; Esc queue &middot; 1&ndash;9 choice &middot; A approve &middot; R reject
      </div>
      <button className={styles.restartButton} onClick={handleRestart}>
        Restart server
      </button>
    </header>
  );
}
