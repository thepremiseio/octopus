import { useConnectionStatus } from '../hooks/useConnection';
import styles from './ConnectionBar.module.css';

export function ConnectionBar() {
  const status = useConnectionStatus();

  if (status === 'connected') return null;

  return (
    <div className={`${styles.bar} ${status === 'connecting' ? styles.connecting : styles.disconnected}`}>
      {status === 'connecting' ? 'Connecting...' : 'Disconnected'}
    </div>
  );
}
