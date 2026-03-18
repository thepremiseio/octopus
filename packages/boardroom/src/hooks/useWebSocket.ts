import { useEffect, useSyncExternalStore } from 'react';
import {
  init,
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
    // Don't destroy on unmount — the WebSocket is a singleton that outlives
    // component lifecycles (React Strict Mode remounts in dev, which would
    // kill the connection mid-handshake and cause spurious errors).
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
