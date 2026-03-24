import { createRestClient, createWsClient } from '@octopus/shared';

const BASE_URL = import.meta.env.VITE_NANOCLAW_URL ?? 'http://localhost:3000';
const baseNormalized = BASE_URL.replace(/\/$/, '');

const wsProtocol = baseNormalized.startsWith('https') ? 'wss:' : 'ws:';
const hostPart = baseNormalized.replace(/^https?:\/\//, '');
const WS_URL = `${wsProtocol}//${hostPart}/ws`;

export const api = createRestClient(baseNormalized);
export const ws = createWsClient(WS_URL);
