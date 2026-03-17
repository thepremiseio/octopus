import { useEffect, useSyncExternalStore } from 'react';
import {
  init,
  destroy,
  getConnectionStatus,
  onConnectionStatus,
  getVersionError,
  onVersionError,
} from '../api/websocket';
import type { ConnectionStatus } from '../api/websocket';

export function useWebSocket(): {
  connectionStatus: ConnectionStatus;
  versionError: boolean;
} {
  useEffect(() => {
    init();
    return () => destroy();
  }, []);

  const connectionStatus = useSyncExternalStore(
    onConnectionStatus,
    getConnectionStatus,
  );

  const versionError = useSyncExternalStore(
    onVersionError,
    getVersionError,
  );

  return { connectionStatus, versionError };
}
