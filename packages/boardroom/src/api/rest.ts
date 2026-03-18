import type {
  ApiErrorEnvelope,
  CostPeriod,
  GetAgentResponse,
  GetAgentsResponse,
  GetBoilerplateResponse,
  GetClaudeMdResponse,
  GetConversationResponse,
  GetConversationsResponse,
  GetCostResponse,
  GetCrossBranchMessagesResponse,
  GetExchangesResponse,
  GetHitlCardResponse,
  GetHitlCardsResponse,
  GetRunActivityResponse,
  GetRunsResponse,
  GetSchedulesResponse,
  GetSharedSpaceIndexResponse,
  GetSharedSpacePageResponse,
  PostAgentRequest,
  PostAgentResponse,
  PostBudgetResetResponse,
  PostConversationResponse,
  PostHitlDecisionRequest,
  PostHitlDecisionResponse,
  PostMessageRequest,
  PostScheduleRequest,
  PostScheduleResponse,
  PostSendMessageResponse,
  PutClaudeMdRequest,
  PutClaudeMdResponse,
  PutSharedSpacePageRequest,
  PutSharedSpacePageResponse,
} from '../types/api';

const API_URL = `http://localhost:${import.meta.env.VITE_NANOCLAW_PORT}/api/v1`;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (res.status === 204) {
    return undefined as T;
  }
  const body: unknown = await res.json();
  if (!res.ok) {
    const envelope = body as ApiErrorEnvelope;
    throw new ApiError(
      envelope.error.code,
      envelope.error.message,
      res.status,
    );
  }
  return body as T;
}

function json(data: unknown): RequestInit {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export function getAgents(): Promise<GetAgentsResponse> {
  return request('/agents');
}

export function createAgent(body: PostAgentRequest): Promise<PostAgentResponse> {
  return request('/agents', { method: 'POST', ...json(body) });
}

export function getAgent(agentId: string): Promise<GetAgentResponse> {
  return request(`/agents/${agentId}`);
}

export function deleteAgent(agentId: string): Promise<void> {
  return request(`/agents/${agentId}`, { method: 'DELETE' });
}

export function getClaudeMd(agentId: string): Promise<GetClaudeMdResponse> {
  return request(`/agents/${agentId}/claude-md`);
}

export function putClaudeMd(agentId: string, body: PutClaudeMdRequest): Promise<PutClaudeMdResponse> {
  return request(`/agents/${agentId}/claude-md`, { method: 'PUT', ...json(body) });
}

export function getBoilerplate(agentId: string): Promise<GetBoilerplateResponse> {
  return request(`/agents/${agentId}/boilerplate`);
}

// ─── Runs & Activity ─────────────────────────────────────────────────────────

export function getRuns(agentId: string, limit?: number, before?: string): Promise<GetRunsResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  if (before !== undefined) params.set('before', before);
  const qs = params.toString();
  return request(`/agents/${agentId}/runs${qs ? `?${qs}` : ''}`);
}

export function getRunActivity(agentId: string, runId: string): Promise<GetRunActivityResponse> {
  return request(`/agents/${agentId}/runs/${runId}/activity`);
}

// ─── Schedules ───────────────────────────────────────────────────────────────

export function getSchedules(agentId: string): Promise<GetSchedulesResponse> {
  return request(`/agents/${agentId}/schedules`);
}

export function createSchedule(agentId: string, body: PostScheduleRequest): Promise<PostScheduleResponse> {
  return request(`/agents/${agentId}/schedules`, { method: 'POST', ...json(body) });
}

export function deleteSchedule(agentId: string, scheduleId: string): Promise<void> {
  return request(`/agents/${agentId}/schedules/${scheduleId}`, { method: 'DELETE' });
}

// ─── Budget ──────────────────────────────────────────────────────────────────

export function resetBudget(agentId: string): Promise<PostBudgetResetResponse> {
  return request(`/agents/${agentId}/budget/reset`, { method: 'POST' });
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export function getConversations(agentId: string): Promise<GetConversationsResponse> {
  return request(`/agents/${agentId}/conversations`);
}

export function createConversation(agentId: string): Promise<PostConversationResponse> {
  return request(`/agents/${agentId}/conversations`, { method: 'POST' });
}

export function getConversation(agentId: string, conversationId: string): Promise<GetConversationResponse> {
  return request(`/agents/${agentId}/conversations/${conversationId}`);
}

export function sendMessage(
  agentId: string,
  conversationId: string,
  body: PostMessageRequest,
): Promise<PostSendMessageResponse> {
  return request(`/agents/${agentId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    ...json(body),
  });
}

// ─── HITL ────────────────────────────────────────────────────────────────────

export function getHitlCards(): Promise<GetHitlCardsResponse> {
  return request('/hitl');
}

export function getHitlCard(cardId: string): Promise<GetHitlCardResponse> {
  return request(`/hitl/${cardId}`);
}

export function postHitlDecision(cardId: string, body: PostHitlDecisionRequest): Promise<PostHitlDecisionResponse> {
  return request(`/hitl/${cardId}/decision`, { method: 'POST', ...json(body) });
}

// ─── Cross-Branch ────────────────────────────────────────────────────────────

export function getCrossBranchMessages(): Promise<GetCrossBranchMessagesResponse> {
  return request('/crossbranch');
}

export function releaseCrossBranch(messageId: string): Promise<void> {
  return request(`/crossbranch/${messageId}/release`, { method: 'POST' });
}

export function dropCrossBranch(messageId: string): Promise<void> {
  return request(`/crossbranch/${messageId}/drop`, { method: 'POST' });
}

// ─── SharedSpace ─────────────────────────────────────────────────────────────

export function getSharedSpaceIndex(): Promise<GetSharedSpaceIndexResponse> {
  return request('/sharedspace');
}

export function getSharedSpacePage(pageId: string): Promise<GetSharedSpacePageResponse> {
  return request(`/sharedspace/${pageId}`);
}

export function putSharedSpacePage(pageId: string, body: PutSharedSpacePageRequest): Promise<PutSharedSpacePageResponse> {
  return request(`/sharedspace/${pageId}`, { method: 'PUT', ...json(body) });
}

export function deleteSharedSpacePage(pageId: string): Promise<void> {
  return request(`/sharedspace/${pageId}`, { method: 'DELETE' });
}

// ─── Debug / Exchanges ──────────────────────────────────────────────────────

export function getExchanges(agentId: string, runId: string): Promise<GetExchangesResponse> {
  return request(`/agents/${agentId}/runs/${runId}/exchanges`);
}

// ─── Cost ────────────────────────────────────────────────────────────────────

export function getCost(period?: CostPeriod): Promise<GetCostResponse> {
  const qs = period ? `?period=${period}` : '';
  return request(`/cost${qs}`);
}
