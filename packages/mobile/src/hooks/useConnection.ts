import { useSyncExternalStore } from 'react';
import type { ConnectionStatus } from '@octopus/shared';
import { ws } from '../api';

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(ws.onConnectionStatus, ws.getConnectionStatus);
}
