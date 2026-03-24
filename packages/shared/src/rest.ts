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
  PutAgentRequest,
  PutAgentResponse,
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
} from './types';

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

export interface RestClient {
  // Agents
  getAgents(): Promise<GetAgentsResponse>;
  createAgent(body: PostAgentRequest): Promise<PostAgentResponse>;
  getAgent(agentId: string): Promise<GetAgentResponse>;
  updateAgent(agentId: string, body: PutAgentRequest): Promise<PutAgentResponse>;
  deleteAgent(agentId: string): Promise<void>;
  getClaudeMd(agentId: string): Promise<GetClaudeMdResponse>;
  putClaudeMd(agentId: string, body: PutClaudeMdRequest): Promise<PutClaudeMdResponse>;
  getBoilerplate(agentId: string): Promise<GetBoilerplateResponse>;
  // Runs
  getRuns(agentId: string, limit?: number, before?: string): Promise<GetRunsResponse>;
  getRunActivity(agentId: string, runId: string): Promise<GetRunActivityResponse>;
  // Schedules
  getSchedules(agentId: string): Promise<GetSchedulesResponse>;
  createSchedule(agentId: string, body: PostScheduleRequest): Promise<PostScheduleResponse>;
  deleteSchedule(agentId: string, scheduleId: string): Promise<void>;
  // Budget
  resetBudget(agentId: string): Promise<PostBudgetResetResponse>;
  // Chat
  getConversations(agentId: string): Promise<GetConversationsResponse>;
  createConversation(agentId: string): Promise<PostConversationResponse>;
  getConversation(agentId: string, conversationId: string): Promise<GetConversationResponse>;
  sendMessage(agentId: string, conversationId: string, body: PostMessageRequest): Promise<PostSendMessageResponse>;
  // HITL
  getHitlCards(): Promise<GetHitlCardsResponse>;
  getHitlCard(cardId: string): Promise<GetHitlCardResponse>;
  postHitlDecision(cardId: string, body: PostHitlDecisionRequest): Promise<PostHitlDecisionResponse>;
  // Cross-Branch
  getCrossBranchMessages(): Promise<GetCrossBranchMessagesResponse>;
  releaseCrossBranch(messageId: string): Promise<void>;
  dropCrossBranch(messageId: string): Promise<void>;
  // SharedSpace
  getSharedSpaceIndex(): Promise<GetSharedSpaceIndexResponse>;
  getSharedSpacePage(pageId: string): Promise<GetSharedSpacePageResponse>;
  putSharedSpacePage(pageId: string, body: PutSharedSpacePageRequest): Promise<PutSharedSpacePageResponse>;
  deleteSharedSpacePage(pageId: string): Promise<void>;
  // Debug
  getExchanges(agentId: string, runId: string): Promise<GetExchangesResponse>;
  // Cost
  getCost(period?: CostPeriod): Promise<GetCostResponse>;
}

export function createRestClient(baseUrl: string): RestClient {
  const apiUrl = baseUrl.replace(/\/$/, '') + '/api/v1';

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${apiUrl}${path}`, init);
    if (res.status === 204) {
      return undefined as T;
    }
    const body: unknown = await res.json();
    if (!res.ok) {
      const envelope = body as ApiErrorEnvelope;
      throw new ApiError(envelope.error.code, envelope.error.message, res.status);
    }
    return body as T;
  }

  function json(data: unknown): RequestInit {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  }

  return {
    getAgents: () => request('/agents'),
    createAgent: (body) => request('/agents', { method: 'POST', ...json(body) }),
    getAgent: (agentId) => request(`/agents/${agentId}`),
    updateAgent: (agentId, body) => request(`/agents/${agentId}`, { method: 'PUT', ...json(body) }),
    deleteAgent: (agentId) => request(`/agents/${agentId}`, { method: 'DELETE' }),
    getClaudeMd: (agentId) => request(`/agents/${agentId}/claude-md`),
    putClaudeMd: (agentId, body) => request(`/agents/${agentId}/claude-md`, { method: 'PUT', ...json(body) }),
    getBoilerplate: (agentId) => request(`/agents/${agentId}/boilerplate`),

    getRuns: (agentId, limit, before) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      if (before !== undefined) params.set('before', before);
      const qs = params.toString();
      return request(`/agents/${agentId}/runs${qs ? `?${qs}` : ''}`);
    },
    getRunActivity: (agentId, runId) => request(`/agents/${agentId}/runs/${runId}/activity`),

    getSchedules: (agentId) => request(`/agents/${agentId}/schedules`),
    createSchedule: (agentId, body) => request(`/agents/${agentId}/schedules`, { method: 'POST', ...json(body) }),
    deleteSchedule: (agentId, scheduleId) =>
      request(`/agents/${agentId}/schedules/${scheduleId}`, { method: 'DELETE' }),

    resetBudget: (agentId) => request(`/agents/${agentId}/budget/reset`, { method: 'POST' }),

    getConversations: (agentId) => request(`/agents/${agentId}/conversations`),
    createConversation: (agentId) => request(`/agents/${agentId}/conversations`, { method: 'POST' }),
    getConversation: (agentId, conversationId) =>
      request(`/agents/${agentId}/conversations/${conversationId}`),
    sendMessage: (agentId, conversationId, body) =>
      request(`/agents/${agentId}/conversations/${conversationId}/messages`, {
        method: 'POST',
        ...json(body),
      }),

    getHitlCards: () => request('/hitl'),
    getHitlCard: (cardId) => request(`/hitl/${cardId}`),
    postHitlDecision: (cardId, body) => request(`/hitl/${cardId}/decision`, { method: 'POST', ...json(body) }),

    getCrossBranchMessages: () => request('/crossbranch'),
    releaseCrossBranch: (messageId) => request(`/crossbranch/${messageId}/release`, { method: 'POST' }),
    dropCrossBranch: (messageId) => request(`/crossbranch/${messageId}/drop`, { method: 'POST' }),

    getSharedSpaceIndex: () => request('/sharedspace'),
    getSharedSpacePage: (pageId) => request(`/sharedspace/${pageId}`),
    putSharedSpacePage: (pageId, body) => request(`/sharedspace/${pageId}`, { method: 'PUT', ...json(body) }),
    deleteSharedSpacePage: (pageId) => request(`/sharedspace/${pageId}`, { method: 'DELETE' }),

    getExchanges: (agentId, runId) => request(`/agents/${agentId}/runs/${runId}/exchanges`),

    getCost: (period) => {
      const qs = period ? `?period=${period}` : '';
      return request(`/cost${qs}`);
    },
  };
}
