// ─── Shared enums / unions ───────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'active' | 'alert' | 'circuit-breaker';

export type CardType = 'approval' | 'choice' | 'fyi' | 'circuit_breaker';

export type Resolution = 'approved' | 'rejected' | 'option_selected' | 'returned';

export type TriggerType = 'chat' | 'inbox' | 'scheduled' | 'hitl_resume' | 'crossbranch_resume';

export type ExitReason =
  | 'completed'
  | 'hitl_pause'
  | 'crossbranch_pause'
  | 'budget_exceeded'
  | 'circuit_breaker'
  | 'error';

export type ToolCategory = 'read' | 'write' | 'hitl' | 'message' | 'shell';

export type EntryType = 'tool_call' | 'tool_result';

export type SharedSpaceOperation = 'created' | 'updated' | 'deleted';

export type MessageRole = 'agent' | 'ceo';

export type CostPeriod = 'today' | 'week' | 'month';

// ─── Shared domain objects ───────────────────────────────────────────────────

export interface Agent {
  agent_id: string;
  agent_name: string;
  parent_id: string | null;
  depth: number;
  status: AgentStatus;
  cost_today_eur: number;
  open_hitl_cards: number;
  last_run_ts: number | null;
}

export interface AgentDetail extends Agent {
  agent_path: string[];
  last_run_exit_reason: ExitReason | null;
  budget_tokens: number | null;
  used_tokens_today: number | null;
  budget_eur: number | null;
}

export interface HitlCard {
  card_id: string;
  card_type: CardType;
  agent_id: string;
  agent_name: string;
  agent_path: string[];
  subject: string;
  context: string;
  options: string[] | null;
  preference: number | null;
  run_id: string;
  created_ts: number;
}

export interface CrossBranchMessage {
  message_id: string;
  from_agent_id: string;
  from_agent_name: string;
  from_agent_path: string[];
  to_agent_id: string;
  to_agent_name: string;
  to_agent_path: string[];
  subject: string;
  body: string;
  run_id: string;
  arrived_ts: number;
}

export interface SharedSpacePage {
  page_id: string;
  title: string;
  summary: string;
  owner_agent_id: string;
  updated_by_agent_id: string;
  updated_ts: number;
  parent_id: string | null;
  depth: number;
}

export interface SharedSpacePageFull extends SharedSpacePage {
  body: string;
}

export interface ActivityEntry {
  entry_id: string;
  entry_type: EntryType;
  tool_name: string;
  tool_category: ToolCategory;
  detail: string;
  outcome: string | null;
  ts: number;
}

export interface ConversationMessage {
  message_id: string;
  role: MessageRole;
  content: string;
  ts: number;
  run_id: string | null;
}

export interface Conversation {
  conversation_id: string;
  started_ts: number;
  last_message_ts: number | null;
  preview: string;
  message_count: number;
  active: boolean;
}

export interface ConversationDetail {
  conversation_id: string;
  agent_id: string;
  started_ts: number;
  active: boolean;
  messages: ConversationMessage[];
}

export interface RunSummary {
  run_id: string;
  trigger_type: TriggerType;
  trigger_detail: string | null;
  started_ts: number;
  completed_ts: number | null;
  exit_reason: ExitReason | null;
  total_tokens: number | null;
}

export interface Schedule {
  schedule_id: string;
  agent_id?: string;
  cron: string;
  name: string;
  enabled: boolean;
  last_run_ts: number | null;
  next_run_ts: number | null;
}

export interface CostAgent {
  agent_id: string;
  agent_name: string;
  cost_eur: number;
}

// ─── Debug / LLM exchanges ──────────────────────────────────────────────────

export interface LlmExchange {
  run_id: string;
  exchange_index: number;
  messages_json: string;
  response_json: string | null;
  tokens_in: number;
  tokens_out: number;
  ts: number;
}

// ─── WebSocket envelope ──────────────────────────────────────────────────────

export interface WsEnvelope<T = unknown> {
  v: number;
  type: string;
  ts: number;
  payload: T;
}

// ─── WebSocket event payloads ────────────────────────────────────────────────

export interface ConnectionReadyPayload {
  server_version: string;
}

export interface ConnectionStateAgentEntry {
  agent_id: string;
  agent_name: string;
  parent_id: string | null;
  depth: number;
  status: AgentStatus;
  cost_today_eur: number;
  open_hitl_cards: number;
}

export interface ConnectionStatePayload {
  agents: ConnectionStateAgentEntry[];
  hitl_queue_count: number;
  crossbranch_queue_count: number;
  total_today_eur: number;
}

export interface HitlCardCreatedPayload {
  card_id: string;
  card_type: CardType;
  agent_id: string;
  agent_name: string;
  agent_path: string[];
  subject: string;
  context: string;
  options: string[] | null;
  preference: number | null;
  run_id: string;
}

export interface HitlCardResolvedPayload {
  card_id: string;
  agent_id: string;
  resolution: Resolution;
  selected_option?: number | null;
  note: string | null;
}

export interface CrossBranchMessageArrivedPayload {
  message_id: string;
  from_agent_id: string;
  from_agent_name: string;
  from_agent_path: string[];
  to_agent_id: string;
  to_agent_name: string;
  to_agent_path: string[];
  subject: string;
  body: string;
  run_id: string;
}

export interface CrossBranchMessageReleasedPayload {
  message_id: string;
  to_agent_id: string;
}

export interface CrossBranchMessageDroppedPayload {
  message_id: string;
  from_agent_id: string;
}

export interface AgentStatusChangedPayload {
  agent_id: string;
  status: AgentStatus;
  previous_status: AgentStatus;
}

export interface AgentRunStartedPayload {
  agent_id: string;
  run_id: string;
  trigger_type: TriggerType;
  trigger_detail: string | null;
}

export interface AgentRunCompletedPayload {
  agent_id: string;
  run_id: string;
  exit_reason: ExitReason;
  total_tokens: number;
  error_detail?: string | null;
}

export interface AgentRunActivityPayload {
  agent_id: string;
  run_id: string;
  entry_id: string;
  entry_type: EntryType;
  tool_name: string;
  tool_category: ToolCategory;
  detail: string;
  outcome: string | null;
}

export interface AgentCreatedPayload {
  agent_id: string;
  agent_name: string;
  parent_id: string | null;
  agent_path: string[];
  depth: number;
  status: AgentStatus;
  cost_today_eur: number;
}

export interface AgentDeletedPayload {
  agent_id: string;
  deleted_subtree: string[];
}

export interface AgentBudgetExceededPayload {
  agent_id: string;
  budget_tokens: number;
  used_tokens: number;
  period: 'daily';
  blocked_trigger_type: string;
}

export interface AgentBudgetCircuitBreakerPayload {
  agent_id: string;
  run_id: string;
  action_count: number;
  window_seconds: number;
  threshold: number;
}

export interface AgentBudgetResetPayload {
  agent_id: string;
  reset_by: 'ceo';
  previous_used_tokens: number;
  budget_tokens: number;
}

export interface ChatMessageReceivedPayload {
  agent_id: string;
  conversation_id: string;
  message_id: string;
  content: string;
  run_id: string;
}

export interface CostUpdatedPayload {
  agent_id: string;
  run_id: string;
  cost_today_eur: number;
  total_today_eur: number;
}

export interface SharedSpacePageUpdatedPayload {
  page_id: string;
  title: string;
  summary: string;
  owner_agent_id: string;
  updated_by_agent_id: string;
  operation: SharedSpaceOperation;
  parent_id: string | null;
  depth: number;
}

export interface InboxMessageDeliveredPayload {
  recipient_agent_id: string;
  message_id: string;
  from_agent_id: string;
  from_agent_name: string;
  subject: string;
  cross_branch: boolean;
}

export interface DebugExchangeRecordedPayload {
  agent_id: string;
  run_id: string;
  exchange_index: number;
  messages_json: string;
  response_json: string | null;
  tokens_in: number;
  tokens_out: number;
  ts: number;
}

// ─── WS event type → payload mapping ────────────────────────────────────────

export interface WsEventMap {
  'connection.ready': ConnectionReadyPayload;
  'connection.state': ConnectionStatePayload;
  'hitl.card.created': HitlCardCreatedPayload;
  'hitl.card.resolved': HitlCardResolvedPayload;
  'crossbranch.message.arrived': CrossBranchMessageArrivedPayload;
  'crossbranch.message.released': CrossBranchMessageReleasedPayload;
  'crossbranch.message.dropped': CrossBranchMessageDroppedPayload;
  'agent.status.changed': AgentStatusChangedPayload;
  'agent.run.started': AgentRunStartedPayload;
  'agent.run.completed': AgentRunCompletedPayload;
  'agent.run.activity': AgentRunActivityPayload;
  'agent.created': AgentCreatedPayload;
  'agent.deleted': AgentDeletedPayload;
  'agent.budget.exceeded': AgentBudgetExceededPayload;
  'agent.budget.circuit_breaker': AgentBudgetCircuitBreakerPayload;
  'agent.budget.reset': AgentBudgetResetPayload;
  'chat.message.received': ChatMessageReceivedPayload;
  'cost.updated': CostUpdatedPayload;
  'sharedspace.page.updated': SharedSpacePageUpdatedPayload;
  'inbox.message.delivered': InboxMessageDeliveredPayload;
  'debug.exchange.recorded': DebugExchangeRecordedPayload;
}

export type WsEventType = keyof WsEventMap;

// ─── REST request types ──────────────────────────────────────────────────────

export interface PostAgentRequest {
  agent_name: string;
  parent_id: string | null;
}

export interface PutClaudeMdRequest {
  content: string;
}

export interface PostScheduleRequest {
  cron: string;
  name: string;
}

export interface PostMessageRequest {
  content: string;
}

export interface PostHitlDecisionRequest {
  resolution: Resolution;
  selected_option?: number;
  note?: string;
}

export interface PutSharedSpacePageRequest {
  title: string;
  summary: string;
  owner_agent_id: string;
  body: string;
}

// ─── REST response types ─────────────────────────────────────────────────────

export interface GetAgentsResponse {
  agents: Agent[];
}

export interface PostAgentResponse {
  agent_id: string;
  agent_name: string;
  parent_id: string | null;
  depth: number;
  status: AgentStatus;
  cost_today_eur: number;
  open_hitl_cards: number;
  last_run_ts: number | null;
}

export type GetAgentResponse = AgentDetail;

export interface GetClaudeMdResponse {
  agent_id: string;
  content: string;
}

export type PutClaudeMdResponse = GetClaudeMdResponse;

export interface GetBoilerplateResponse {
  agent_id: string;
  content: string;
}

export interface GetRunsResponse {
  agent_id: string;
  runs: RunSummary[];
  has_more: boolean;
}

export interface GetRunActivityResponse {
  run_id: string;
  agent_id: string;
  status: 'active' | 'completed';
  entries: ActivityEntry[];
}

export interface GetSchedulesResponse {
  agent_id: string;
  schedules: Schedule[];
}

export type PostScheduleResponse = Schedule;

export interface PostBudgetResetResponse {
  agent_id: string;
  budget_tokens: number;
  used_tokens: number;
}

export interface GetConversationsResponse {
  agent_id: string;
  conversations: Conversation[];
}

export type PostConversationResponse = ConversationDetail;

export type GetConversationResponse = ConversationDetail;

export interface PostSendMessageResponse {
  message_id: string;
  conversation_id: string;
  agent_id: string;
  role: 'ceo';
  content: string;
  ts: number;
}

export interface GetHitlCardsResponse {
  cards: HitlCard[];
}

export type GetHitlCardResponse = HitlCard;

export interface PostHitlDecisionResponse {
  card_id: string;
  resolution: Resolution;
}

export interface GetCrossBranchMessagesResponse {
  messages: CrossBranchMessage[];
}

export interface GetSharedSpaceIndexResponse {
  pages: SharedSpacePage[];
}

export type GetSharedSpacePageResponse = SharedSpacePageFull;

export type PutSharedSpacePageResponse = SharedSpacePageFull;

export interface GetCostResponse {
  period: CostPeriod;
  from_ts: number;
  to_ts: number;
  total_eur: number;
  agents: CostAgent[];
}

export interface GetExchangesResponse {
  run_id: string;
  agent_id: string;
  exchanges: LlmExchange[];
}

// ─── REST error envelope ─────────────────────────────────────────────────────

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}
