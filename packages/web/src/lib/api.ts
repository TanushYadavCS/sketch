/**
 * Typed API client for the control plane backend.
 * All methods throw on non-2xx responses with the standard error shape.
 */

import type { SkillCategory } from "@/lib/skills-data";
import type {
  AgentEnvironmentShareTargetInput,
  AgentEnvironmentVariableRecord,
  FileMetadata,
  IntegrationApp,
  IntegrationConnection,
  LlmProvider,
  McpServerRecord,
  PageInfo,
} from "@sketch/shared";

export type WorkspaceScope = "personal" | "org";

export interface ApiError {
  error: { code: string; message: string };
}

export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface LocalDeviceRecord {
  id: string;
  name: string;
  platform: string;
  prefix: string;
  status: "online" | "offline" | "revoked";
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export class ApiRequestError extends Error {
  status: number;
  code: string;
  /** Raw error object from the response — may carry extra fields beyond message/code. */
  details: Record<string, unknown>;
  constructor(message: string, status: number, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface User {
  id: string;
  name: string;
  email: string | null;
  email_verified_at: string | null;
  auth_role: "admin" | "member";
  slack_user_id: string | null;
  whatsapp_number: string | null;
  description: string | null;
  type: string;
  role: string | null;
  reports_to: string | null;
  allowed_tools: string[] | null;
  slack_channel_ids: string[];
  whatsapp_group_jids: string[];
  is_whatsapp_fallback: boolean;
  created_at: string;
}

export interface ScheduledTaskListItem {
  id: string;
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  threadTs: string | null;
  prompt: string;
  scheduleType: "cron" | "interval" | "once" | "external";
  scheduleValue: string;
  timezone: string;
  sessionMode: "fresh";
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: "active" | "paused" | "completed";
  createdBy: string | null;
  createdAt: string;
  targetLabel: string;
  targetKindLabel: "Slack DM" | "Slack channel" | "WhatsApp DM" | "WhatsApp group";
  creatorName: string | null;
  scheduleLabel: string;
  canPause: boolean;
  canResume: boolean;
  canDelete: boolean;
  title: string | null;
  description: string | null;
  steps: string | null;
  stepCount: number;
  triggerConfig: WorkflowTriggerConfig | null;
  outputTarget: string | null;
  outputPlatform: string | null;
  outputThreadTs: string | null;
  outputMode: "deliver" | "silent";
  delivery: {
    platform: "slack" | "whatsapp";
    targetType: "dm" | "channel" | "group" | "thread";
    targetId: string;
    threadTs: string | null;
    mode: "deliver" | "silent";
    label: string;
  };
  lastRunStatus: string | null;
  runCount: number;
}

export interface WorkflowTriggerConfig {
  type: "webhook" | "schedule" | "canvas";
  scheduleType?: "cron" | "interval" | "once";
  scheduleValue?: string;
  timezone?: string;
  app?: string;
  eventDescription?: string;
  componentKey?: string;
  configuredProps?: Record<string, unknown>;
  status?: "pending_canvas_setup" | "active" | "error";
  canvasWorkflowId?: string;
  canvasTriggerNodeId?: string;
  canvasActionNodeId?: string;
  errorMessage?: string;
}

export interface AutomationRunItem {
  id: string;
  task_id: string;
  trigger_data: string | null;
  status: "running" | "completed" | "failed";
  step_outputs: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AutomationStepContentItem {
  task_id: string;
  step_id: string;
  content_type: "prompt" | "script";
  content: string;
  apps: string | null;
  updated_at: string;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((options?.headers as Record<string, string>) ?? {}) };
  // Skip Content-Type for FormData — the browser sets it automatically with the correct multipart boundary
  if (options?.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: { code: "UNKNOWN", message: res.statusText } }))) as {
      error: { code: string; message: string } & Record<string, unknown>;
    };
    const { code, message, ...rest } = body.error;
    throw new ApiRequestError(message, res.status, code, rest);
  }

  // 204 No Content has no body to parse — callers that type the response as
  // `void` rely on this fast-path.
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

export interface ChannelStatus {
  platform: "slack" | "whatsapp" | "email";
  configured: boolean;
  connected: boolean | null;
  phoneNumber?: string | null;
  fromAddress?: string | null;
  outboundOnly?: boolean;
}

export interface SlackChannelInfo {
  id: string;
  name: string;
  type: string;
  isMember: boolean;
}

export interface WhatsAppGroupInfo {
  jid: string;
  name: string;
  description: string | null;
  agent_user_id: string | null;
  updated_at: string;
}

export interface SetupStatus {
  completed: boolean;
  currentStep: number;
  adminEmail: string | null;
  orgName: string | null;
  botName: string;
  slackConnected: boolean;
  llmConnected: boolean;
  llmProvider: LlmProvider | null;
  experimentalFlag?: boolean;
  managedUrl?: string;
}

export interface EntityReviewQueueRow {
  id: string;
  proposed_name: string;
  normalized_name: string;
  entity_type: string;
  proposed_email: string | null;
  candidate_entity_id: string | null;
  candidate_score: number | null;
  candidate_reason: string | null;
  candidate_generated_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  status: "pending" | "confirmed" | "rejected" | "confirming";
  triggered_by_user_id: string;
  review_started_at: string | null;
  review_started_by: string | null;
  backfill_cursor: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolved_entity_id: string | null;
  evidenceCount: number;
  sourceBreakdown: Array<{ source: string; count: number }>;
  candidate: { id: string; name: string; email: string | null } | null;
}

export interface EntityReviewEvidenceRow {
  id: string;
  review_id: string;
  indexed_file_id: string;
  source: string;
  note: string | null;
  seen_at: string;
  file: {
    name: string;
    providerUrl: string | null;
    sourcePath: string | null;
  };
}

export interface EntityMention {
  id: string;
  contextSnippet: string | null;
  chunkIndex: number | null;
  mentionedAt: string;
  sourceDate: string;
  file: {
    id: string;
    fileName: string;
    fileType: string | null;
    source: string;
    sourcePath: string | null;
    providerUrl: string | null;
  };
}

export interface EntityReviewListResponse {
  rows: EntityReviewQueueRow[];
  total: number;
}

export interface EntityReviewDetailResponse {
  row: EntityReviewQueueRow;
  evidence: EntityReviewEvidenceRow[];
}

export interface EntityReviewConfirmResult {
  row: EntityReviewQueueRow;
  targetEntityId: string;
  shortCircuited: boolean;
  mergedStaleEntityId: string | null;
  idempotent: boolean;
}

export interface EntityReviewRejectResult {
  row: EntityReviewQueueRow;
  targetEntityId: string;
  reResolvedToExisting: boolean;
  createdEntityId: string | null;
  idempotent: boolean;
}

/**
 * Closed set of error codes the entity-review API emits. Mirrors
 * `REVIEW_ERROR_CODES` on the server. The UI switches on these to render
 * locked copy.
 */
export type EntityReviewErrorCode =
  | "CANDIDATE_DRIFT"
  | "CANDIDATE_MISSING"
  | "TARGET_DELETED"
  | "MULTIPLE_STALE_CANDIDATES"
  | "MULTIPLE_RE_RESOLVE_MATCHES"
  | "ALREADY_CONFIRMING"
  | "EVIDENCE_TOO_LARGE"
  | "TYPE_MISMATCH"
  | "ROW_NOT_FOUND"
  | "OWNER_SCOPE_DENIED";

export function isEntityReviewErrorCode(code: string | undefined): code is EntityReviewErrorCode {
  if (!code) return false;
  return (
    code === "CANDIDATE_DRIFT" ||
    code === "CANDIDATE_MISSING" ||
    code === "TARGET_DELETED" ||
    code === "MULTIPLE_STALE_CANDIDATES" ||
    code === "MULTIPLE_RE_RESOLVE_MATCHES" ||
    code === "ALREADY_CONFIRMING" ||
    code === "EVIDENCE_TOO_LARGE" ||
    code === "TYPE_MISMATCH" ||
    code === "ROW_NOT_FOUND" ||
    code === "OWNER_SCOPE_DENIED"
  );
}

export interface EntityListItem {
  id: string;
  name: string;
  sourceType: string;
  subtype: string | null;
  aliases: string[];
  metadata: Record<string, unknown> | null;
  status: string;
  hotness: number;
  mentionCount: number;
  lastMentionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DrawerEntityType = "person" | "company" | "product" | "project" | "team" | "system" | "other";

export interface EntityProfileSummary {
  identity: string;
  activity: string;
}

export interface EntityProfile {
  entityType: DrawerEntityType;
  mentionCount: number;
  sourceCounts: Record<string, number>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  domainsForCompany: Array<{ domain: string; confidence: number; isPrimary: boolean }>;
  summary: EntityProfileSummary;
}

export interface EntityManualShare {
  email: string;
  grantedAt: string;
}

export interface EntityDetail extends EntityListItem {
  profile: EntityProfile;
  shareWithEveryone: boolean;
  manualShares: EntityManualShare[];
}

export interface EntitySharesResponse {
  shares: EntityManualShare[];
  shareWithEveryone: boolean;
}

export interface EntitySourceRef {
  id: string;
  source: string;
  sourceId: string;
  sourceUrl: string | null;
  lastSeenAt: string;
}

export type RelationConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface EntityRelationView {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: string;
  confidence: string;
  confidenceScore: number;
  source: string;
  validFrom: string | null;
  validTo: string | null;
  other: {
    id: string;
    name: string;
    sourceType: string;
    aliases: string[];
  };
  evidenceCount: number;
  reviewId?: string;
}

export interface EntityRelationsResponse {
  outgoing: EntityRelationView[];
  incoming: EntityRelationView[];
  truncated: boolean;
  totalCount: number;
}

export interface EntityRelationEvidenceRow {
  fileId: string;
  fileName: string;
  sourceType: string;
  occurredAt: string;
  chunkIndex: number | null;
  contextSnippet: string | null;
  sourceFactId: string | null;
  note: string | null;
}

export interface EntityRelationEvidenceResponse {
  rows: EntityRelationEvidenceRow[];
  visibleCount: number;
  totalCount: number;
  truncated: boolean;
}

export interface EntityTimelineItem {
  fileId: string;
  fileName: string;
  fileType: string | null;
  contentCategory: string;
  sourceType: string;
  occurredAt: string;
  mentionConfidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  mentionCount: number;
  contextSnippet: string | null;
  url: string | null;
  rollupGroupId: string | null;
  crmActivity: {
    activityType: "task" | "call" | "event" | "meeting" | "note";
    hasBody: boolean;
  } | null;
}

export interface EntityTimelineGroup {
  month: string;
  items: EntityTimelineItem[];
}

export interface EntityTimelineResponse {
  groups: EntityTimelineGroup[];
  truncated: boolean;
  totalCount: number;
}

export type ReenrichScope = { all: true } | { fileIds: string[] } | { sources: string[] };

export type ResetCategory = "manual" | "connectors" | "ai";

export type ResetJobPhase = "idle" | "resetting" | "reset_done" | "replaying_facts" | "enriching" | "done" | "failed";

export type ReenrichJobPhase = "idle" | "wiping" | "enriching" | "rebuilding" | "done" | "failed" | "cancelled";

export type RebuildOnlyJobPhase = "idle" | "replaying_facts" | "enriching" | "done" | "failed";

export type RebuildJobPhase = ResetJobPhase | ReenrichJobPhase | RebuildOnlyJobPhase;

export interface RebuildJobProgress {
  phase: string;
  completed: number;
  total: number;
}

export type RebuildJobKind = "reset" | "reenrich" | "rebuild";

export interface RebuildJobRequest {
  categories?: ResetCategory[];
  scope?: ReenrichScope;
  runAfter?: boolean;
  wipeLlmFacts?: boolean;
  pendingRebuildId?: string;
}

export interface RebuildJob {
  id: string;
  phase: RebuildJobPhase;
  startedAt: string;
  finishedAt: string | null;
  request?: RebuildJobRequest;
  progress?: RebuildJobProgress;
  reset?: {
    deleted: Record<string, number>;
    factsMarkedUnmaterialized: number;
  };
  pendingRebuildId?: string;
  pendingRebuildExpiresAt?: string;
  llmFactsWiped?: {
    factsTombstoned: number;
    relationshipEvidenceDeleted: number;
    relationshipsDeleted: number;
  };
  replay?: {
    factsRead: number;
    entitiesCreated: number;
    entitiesLinked: number;
    mentionsWritten: number;
    relationshipsWritten: number;
    materialized: number;
  };
  recreate?: unknown;
  summary?: {
    scope?: { fileIds: string[]; missingFileIds: string[] };
    wipe?: { files: number; mentions: number; factsTombstoned: number };
    enrichment?: { filesProcessed: number; filesFailed: number };
    recreate?: {
      replay?: {
        entitiesCreated: number;
        entitiesLinked: number;
        mentionsWritten: number;
        relationshipsWritten: number;
      };
    };
  };
  error?: string;
}

export interface RebuildJobsResponse {
  active: boolean;
  currentJob: RebuildJob | null;
  latestJob: RebuildJob | null;
  blockedBy: { code: string; message: string } | null;
}

export interface ResetSubmitResponse {
  message: string;
  job?: { id: string; phase: string; startedAt: string; pendingRebuildId?: string; pendingRebuildExpiresAt?: string };
  /** Present only when runAfter=false (two-step flow). */
  pendingRebuildId?: string;
  pendingRebuildExpiresAt?: string;
  /** Present only on dry-run. */
  dryRun?: boolean;
  entitiesDeleted?: number;
  candidatesCleared?: number;
  reviewQueueCleared?: number;
  reviewEvidenceCleared?: number;
  rejectionsCleared?: number;
  factsMarkedUnmaterialized?: number;
}

export interface RebuildSubmitResponse {
  message: string;
  job: { id: string; phase: string; startedAt: string };
}

export interface ReenrichSubmitResponse {
  message?: string;
  /** Present only on dry-run. */
  dryRun?: boolean;
  files?: number;
  missingFileIds?: string[];
  factsByType?: Record<string, number>;
  job?: { id: string; phase: string; startedAt: string };
}

export interface BrowseFlatItem {
  id: string;
  name: string;
  url?: string;
}

export interface BrowseNestedGroup {
  id: string;
  name: string;
  items: BrowseFlatItem[];
}

export interface BrowseTreeItem {
  id: string;
  name: string;
  hasChildren?: boolean;
}

export type BrowseResult =
  | { type: "flat"; items: BrowseFlatItem[] }
  | { type: "nested"; groups: BrowseNestedGroup[] }
  | { type: "tree"; items: BrowseTreeItem[]; groups?: BrowseNestedGroup[] };

export interface ConnectorConfig {
  id: string;
  connectorType: string;
  authType: string;
  scopeConfig: Record<string, unknown>;

  syncStatus: "active" | "syncing" | "error" | "paused" | "pending";
  lastSyncedAt: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: string;
  fileCount?: number;
}

export interface ConnectorFile {
  id: string;
  fileName: string;
  fileType: string | null;
  contentCategory: "document" | "structured";
  source: string;
  sourcePath: string | null;
  providerUrl: string | null;
  syncedAt: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  hasSummary: boolean;
  summaryStatus: string;
  embeddingStatus: string;
  accessScope: "restricted" | "unrestricted";
  accessCount: number | null;
  /** Present on collapsed CRM object anchors that roll up activity members. */
  resultKind?: "crm_object";
  activityCount?: number;
  rollupSummary?: string;
}

export interface FileContent {
  id: string;
  fileName: string;
  fileType: string | null;
  content: string | null;
  summary: string | null;
  contextNote: string | null;
  tags: string | null;
  source: string;
  sourcePath: string | null;
  providerUrl: string | null;
  enrichmentStatus: string;
  /** Present for email_message files — lets the detail sheet load the full thread. */
  emailThread?: { connectorId: string; threadKey: string };
}

export interface EmailAddr {
  name?: string | null;
  email: string;
}

export interface EmailThreadSummary {
  threadKey: string;
  latestIndexedFileId: string;
  latestSubject: string | null;
  messageCount: number;
  lastActivity: string | null;
  participants: string[];
}

export interface EmailThreadMessage {
  indexedFileId: string;
  subject: string | null;
  sentAt: string | null;
  from: EmailAddr;
  to: EmailAddr[];
  cc: EmailAddr[];
  providerUrl: string | null;
  content: string | null;
}

export interface FileAccessMember {
  email: string;
  userName: string | null;
  userId: string | null;
  source: "scope" | "file";
  mapped: boolean;
}

export interface LinkedEntity {
  id: string;
  name: string;
  sourceType: string;
  subtype: string | null;
}

/** A file returned by the paginated all-files endpoint. */
export type UnifiedFile = ConnectorFile;

/** A result from hybrid search (FTS5 + vector). */
export interface SearchResult {
  resultKind?: "file" | "email_thread";
  id: string;
  hitFileId?: string;
  fileName: string;
  source: string;
  contentCategory: string;
  summary: string | null;
  providerUrl: string | null;
  sourcePath: string | null;
  sourceUpdatedAt: string | null;
  tags: string | null;
  snippet: string | null;
  similarity: number | null;
  score: number;
  threadKey?: string;
  messageCount?: number;
  latestSubject?: string;
  lastActivity?: string | null;
  participants?: string[];
}

export interface FileManualShare {
  email: string;
  grantedAt: string;
}

export interface FileAccess {
  scope: "restricted" | "unrestricted";
  members: FileAccessMember[];
  manualShares: FileManualShare[];
  shareWithEveryone: boolean;
}

export interface FileSharesResponse {
  shares: FileManualShare[];
  shareWithEveryone: boolean;
}

export interface ProviderIdentity {
  id: string;
  provider: string;
  providerUserId: string;
  providerEmail: string | null;
  connectedAt: string;
  hasToken: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  role?: "admin" | "member";
  email?: string;
  userId?: string;
  name?: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  body: string;
}

export interface WorkspaceSummary {
  automations: {
    total: number;
    active: number;
    paused: number;
    completed: number;
    running: number;
    nextRunAt: string | null;
  };
  skills: {
    total: number;
    yours: number;
    shared: number;
  };
  integrations: {
    connected: number;
    appNames: string[];
  };
  team: {
    total: number;
    humans: number;
    agents: number;
  };
}

export type WebChatMessagePart =
  | { type: "text"; text: string }
  | { type: "data-progress"; id: string; data: { lines: string[] } }
  | {
      type: "data-file";
      id: string;
      data: {
        name: string;
        url: string;
        mediaType: string;
        sizeBytes?: number;
      };
    };

export interface WebChatStoredMessage {
  id: string;
  role: "user" | "assistant";
  createdAt?: string;
  parts: WebChatMessagePart[];
}

export interface WebChatMessagesResponse {
  messages: WebChatStoredMessage[];
  updatedAt: string | null;
}

export interface WebChatConversationSummary {
  id: string;
  title: string;
  channel: "web";
  updatedAt: string;
}

export const api = {
  webChat: {
    messages(conversationId = "default") {
      return request<WebChatMessagesResponse>(
        `/api/web-chat/messages?conversationId=${encodeURIComponent(conversationId)}`,
      );
    },
    conversations() {
      return request<{ conversations: WebChatConversationSummary[] }>("/api/web-chat/conversations");
    },
    removeConversation(conversationId: string) {
      return request<{ success: boolean }>(`/api/web-chat/conversations/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
      });
    },
  },
  setup: {
    status() {
      return request<SetupStatus>("/api/setup/status");
    },
    verifySlack(botToken: string, appToken: string) {
      return request<{ success: boolean; workspaceName?: string }>("/api/setup/slack/verify", {
        method: "POST",
        body: JSON.stringify({ botToken, appToken }),
      });
    },
    verifyLlm(
      data:
        | { provider: "anthropic"; apiKey: string }
        | { provider: "bedrock"; awsAccessKeyId: string; awsSecretAccessKey: string; awsRegion: string },
    ) {
      return request<{ success: boolean }>("/api/setup/llm/verify", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    createAccount(email: string, password: string) {
      return request<{ success: boolean }>("/api/setup/account", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    },
    identity(orgName: string, botName: string) {
      return request<{ success: boolean }>("/api/setup/identity", {
        method: "POST",
        body: JSON.stringify({ orgName, botName }),
      });
    },
    slack(botToken: string, appToken: string) {
      return request<{ success: boolean }>("/api/setup/slack", {
        method: "POST",
        body: JSON.stringify({ botToken, appToken }),
      });
    },
    llm(
      data:
        | { provider: "anthropic"; apiKey: string }
        | { provider: "bedrock"; awsAccessKeyId: string; awsSecretAccessKey: string; awsRegion: string },
    ) {
      return request<{ success: boolean }>("/api/setup/llm", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    complete() {
      return request<{ success: boolean }>("/api/setup/complete", {
        method: "POST",
      });
    },
  },
  auth: {
    login(email: string, password: string) {
      return request<{ authenticated: boolean; email: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    },
    logout() {
      return request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" });
    },
    session() {
      return request<SessionResponse>("/api/auth/session");
    },
    magicLink: {
      request(email: string) {
        return request<{ success: boolean; channels: string[] }>("/api/auth/magic-link", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
      },
    },
  },
  channels: {
    status() {
      return request<{ channels: ChannelStatus[] }>("/api/channels/status");
    },
    listSlack() {
      return request<{ channels: SlackChannelInfo[] }>("/api/channels/slack");
    },
    listWhatsAppGroups() {
      return request<{ groups: WhatsAppGroupInfo[] }>("/api/channels/whatsapp/groups");
    },
    disconnectSlack() {
      return request<{ success: boolean }>("/api/channels/slack", { method: "DELETE" });
    },
    testEmail(config: { host: string; port: number; user: string; password: string; from: string }) {
      return request<{ success: boolean }>("/api/channels/email/test", {
        method: "POST",
        body: JSON.stringify(config),
      });
    },
    saveEmail(config: { host: string; port: number; user: string; password: string; from: string }) {
      return request<{ success: boolean }>("/api/channels/email", {
        method: "PUT",
        body: JSON.stringify(config),
      });
    },
    deleteEmail() {
      return request<{ success: boolean }>("/api/channels/email", { method: "DELETE" });
    },
  },
  whatsapp: {
    cancelPairing() {
      return request<{ success: boolean }>("/api/channels/whatsapp/pair", { method: "DELETE" });
    },
    disconnect() {
      return request<{ success: boolean }>("/api/channels/whatsapp", { method: "DELETE" });
    },
  },
  settings: {
    identity() {
      return request<{
        orgName: string | null;
        botName: string;
        orgContext: { description?: string; industry?: string } | null;
      }>("/api/settings/identity");
    },
    updateIdentity(data: { orgName?: string; orgContext?: { description?: string; industry?: string } }) {
      return request<{
        orgName: string | null;
        botName: string;
        orgContext: { description?: string; industry?: string } | null;
      }>("/api/settings/identity", { method: "PUT", body: JSON.stringify(data) });
    },
    apiKey() {
      return request<{ configured: boolean; apiKey: string | null }>("/api/settings/api-key");
    },
    generateApiKey() {
      return request<{ configured: true; apiKey: string }>("/api/settings/api-key", { method: "POST" });
    },
    revokeApiKey() {
      return request<{ success: true }>("/api/settings/api-key", { method: "DELETE" });
    },
    access() {
      return request<{ adminCanReadAllFiles: boolean }>("/api/settings/access");
    },
    updateAccess(data: { adminCanReadAllFiles: boolean }) {
      return request<{ adminCanReadAllFiles: boolean }>("/api/settings/access", {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    searchConfig() {
      return request<{ geminiApiKeyConfigured: boolean; enrichmentEnabled: number; syncIntervalMinutes: number }>(
        "/api/settings/search",
      );
    },
    updateSearchConfig(data: {
      geminiApiKey?: string | null;
      enrichmentEnabled?: boolean;
      syncIntervalMinutes?: number;
    }) {
      return request<{ geminiApiKeyConfigured: boolean; enrichmentEnabled: number; syncIntervalMinutes: number }>(
        "/api/settings/search",
        {
          method: "PUT",
          body: JSON.stringify(data),
        },
      );
    },
    runEnrichment() {
      return request<{ success: boolean; message: string }>("/api/settings/search/enrichments", {
        method: "POST",
      });
    },
  },
  apiTokens: {
    list() {
      return request<{ tokens: ApiTokenRecord[]; mcpUrl: string | null }>("/api/api-tokens");
    },
    create(data: { name: string }) {
      return request<{ token: ApiTokenRecord; plaintext: string; mcpUrl: string | null }>("/api/api-tokens", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    revoke(id: string) {
      return request<{ success: true }>(`/api/api-tokens/${id}`, { method: "DELETE" });
    },
  },
  localDevices: {
    list() {
      return request<{ devices: LocalDeviceRecord[]; baseUrl: string; websocketUrl: string }>("/api/local-devices");
    },
    create(data: { name: string; platform?: string }) {
      return request<{ device: LocalDeviceRecord; plaintext: string; baseUrl: string; websocketUrl: string }>(
        "/api/local-devices",
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      );
    },
    revoke(id: string) {
      return request<{ success: true }>(`/api/local-devices/${id}`, { method: "DELETE" });
    },
  },
  integrations: {
    list() {
      return request<{ connectors: ConnectorConfig[] }>("/api/connectors");
    },
    get(id: string) {
      return request<{ connector: ConnectorConfig }>(`/api/connectors/${id}`);
    },
    connect(data: {
      connectorType: string;
      authType: string;
      credentials: Record<string, unknown>;
      scopeConfig?: Record<string, unknown>;
    }) {
      return request<{ connector: { id: string; connectorType: string; syncStatus: string } }>("/api/connectors", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    disconnect(id: string) {
      return request<{ success: boolean }>(`/api/connectors/${id}`, { method: "DELETE" });
    },
    entityCount(id: string) {
      return request<{ count: number }>(`/api/connectors/${id}/entity-count`);
    },
    suppressedEmails(id: string, opts?: { limit?: number; offset?: number }) {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<{
        countsByReason: Record<string, number>;
        recent: Array<{
          providerFileId: string;
          providerMessageId: string | null;
          threadId: string | null;
          reason: string;
          observedAt: string;
        }>;
        total: number;
        hasMore: boolean;
      }>(`/api/connectors/${id}/suppressed-emails${qs ? `?${qs}` : ""}`);
    },
    emailThreads(id: string, opts?: { limit?: number; offset?: number }) {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<{ threads: EmailThreadSummary[]; total: number; hasMore: boolean }>(
        `/api/connectors/${id}/email-threads${qs ? `?${qs}` : ""}`,
      );
    },
    emailThread(id: string, threadKey: string) {
      return request<{ messages: EmailThreadMessage[] }>(
        `/api/connectors/${id}/email-threads/${encodeURIComponent(threadKey)}`,
      );
    },
    sync(id: string) {
      return request<{ sync: { connectorId: string; status: string } }>(`/api/connectors/${id}/syncs`, {
        method: "POST",
      });
    },
    listMine() {
      return request<{
        connectors: Array<{
          id: string;
          connectorType: string;
          credentialHint: string | null;
          syncStatus: string;
          lastSyncedAt: string | null;
          errorMessage: string | null;
          createdAt: string;
          fileCount: number;
        }>;
      }>("/api/connectors/mine");
    },
    rotateKey(id: string, apiKey: string) {
      return request<{ ok: boolean }>(`/api/connectors/${id}/rotate-key`, {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey }),
      });
    },
    progress() {
      return request<{
        active: Array<{
          connectorId: string;
          connectorType: string;
          phase: "syncing" | "enriching";
          itemsProcessed: number;
          itemsCreated: number;
          itemsSkipped: number;
          startedAt: string;
        }>;
        pendingEnrichment: number;
        enrichmentActive: boolean;
        enrichmentStats: {
          total: number;
          enriched: number;
          summarized: number;
        };
      }>("/api/connectors/progress");
    },
    files(id: string) {
      return request<{ files: ConnectorFile[] }>(`/api/connectors/${id}/files`);
    },
    fileCountsBySource() {
      return request<{ counts: Array<{ source: string; count: number }> }>("/api/connectors/file-counts-by-source");
    },
    allFiles(opts?: {
      limit?: number;
      offset?: number;
      source?: string;
      category?: string;
      status?: string;
      access?: string;
    }) {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      if (opts?.source) params.set("source", opts.source);
      if (opts?.category) params.set("category", opts.category);
      if (opts?.status) params.set("status", opts.status);
      if (opts?.access) params.set("access", opts.access);
      const qs = params.toString();
      return request<{ files: UnifiedFile[]; total: number; enrichedTotal: number; hasMore: boolean }>(
        `/api/connectors/all-files${qs ? `?${qs}` : ""}`,
      );
    },
    fileActivities(fileId: string) {
      return request<{ files: UnifiedFile[]; hasMore: boolean }>(`/api/connectors/all-files/${fileId}/activities`);
    },
    search(opts: { query: string; source?: string; category?: string; limit?: number }) {
      const params = new URLSearchParams();
      params.set("query", opts.query);
      if (opts.source) params.set("source", opts.source);
      if (opts.category) params.set("category", opts.category);
      if (opts.limit) params.set("limit", String(opts.limit));
      return request<{ results: SearchResult[] }>(`/api/connectors/search?${params.toString()}`);
    },
    fileContent(fileId: string) {
      return request<{ file: FileContent; access: FileAccess; entities: LinkedEntity[] }>(
        `/api/connectors/files/${fileId}/content`,
      );
    },
    listFileShares(fileId: string) {
      return request<FileSharesResponse>(`/api/connectors/files/${fileId}/shares`);
    },
    updateFileShares(fileId: string, data: { emails: string[]; shareWithEveryone?: boolean }) {
      return request<FileSharesResponse>(`/api/connectors/files/${fileId}/shares`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    revokeFileShare(fileId: string, email: string) {
      return request<{ success: boolean }>(`/api/connectors/files/${fileId}/shares/${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
    },
    enrich(id: string, data: { fileIds: string[]; instruction: string }) {
      return request<{ enrichment: { jobId: string; connectorId: string; fileCount: number } }>(
        `/api/connectors/${id}/enrichments`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      );
    },
    enrichFile(fileId: string) {
      return request<{ success: boolean; fileId: string; fileName: string }>(
        `/api/connectors/files/${fileId}/enrichments`,
        {
          method: "POST",
        },
      );
    },
    browseGoogleDrive(credentials: { client_id: string; client_secret: string; refresh_token: string }) {
      return request<{
        sharedDrives: Array<{ id: string; name: string }>;
        rootFolders: Array<{ id: string; name: string }>;
      }>("/api/connectors/google-drive/browse", {
        method: "POST",
        body: JSON.stringify({ credentials }),
      });
    },
    browseGoogleDriveExisting(connectorId: string) {
      return request<{
        sharedDrives: Array<{ id: string; name: string; selected: boolean }>;
        rootFolders: Array<{ id: string; name: string; selected: boolean }>;
      }>(`/api/connectors/google-drive/browse/${connectorId}`);
    },
    browseFolderContents(connectorId: string, folderId: string) {
      return request<{
        items: Array<{ id: string; name: string; mimeType: string; isFolder: boolean }>;
      }>(`/api/connectors/google-drive/browse/${connectorId}/folder/${folderId}`);
    },
    browseClickUp(credentials: { api_key: string }) {
      return request<{
        workspaces: Array<{
          id: string;
          name: string;
          memberCount: number;
          spaces: Array<{ id: string; name: string; private: boolean }>;
        }>;
      }>("/api/connectors/clickup/browse", {
        method: "POST",
        body: JSON.stringify({ credentials }),
      });
    },
    browseClickUpExisting(connectorId: string) {
      return request<{
        workspaces: Array<{
          id: string;
          name: string;
          memberCount: number;
          selected: boolean;
          spaces: Array<{ id: string; name: string; private: boolean; selected: boolean }>;
        }>;
      }>(`/api/connectors/clickup/browse/${connectorId}`);
    },
    browseNotionStart(credentials: { api_key: string }) {
      return request<{ browseId: string }>("/api/connectors/notion/browse", {
        method: "POST",
        body: JSON.stringify({ credentials }),
      });
    },
    browseNotionStatus(browseId: string) {
      return request<{
        scanning: boolean;
        pagesScanned: number;
        rootPages: Array<{ id: string; title: string; url: string }>;
        error?: string;
      }>(`/api/connectors/notion/browse-status/${browseId}`);
    },
    browseNotionExisting(connectorId: string) {
      return request<{
        rootPages: Array<{ id: string; title: string; url: string; selected: boolean }>;
      }>(`/api/connectors/notion/browse/${connectorId}`);
    },
    /** Generic browse for new connection — delegates to connector.browse() */
    browse(connectorType: string, credentials: Record<string, unknown>) {
      return request<BrowseResult | { type: "async"; jobId: string }>("/api/connectors/browse", {
        method: "POST",
        body: JSON.stringify({ connectorType, credentials }),
      });
    },
    /** Generic browse for existing connector. Returns cached data if available. */
    browseExisting(connectorId: string, refresh = false) {
      const qs = refresh ? "?refresh=true" : "";
      return request<
        (BrowseResult | { type: "async"; jobId: string }) & { scopeConfig?: Record<string, unknown>; cached?: boolean }
      >(`/api/connectors/${connectorId}/browse${qs}`);
    },
    /** Poll async browse status */
    browseStatus(jobId: string) {
      return request<{
        scanning: boolean;
        pagesScanned: number;
        rootPages: Array<{ id: string; title: string; url: string }>;
        error?: string;
      }>(`/api/connectors/browse-status/${jobId}`);
    },
    /** Browse folder children for tree pickers */
    browseChildren(connectorId: string, parentId: string) {
      return request<{ items: Array<{ id: string; name: string; hasChildren?: boolean }> }>(
        `/api/connectors/${connectorId}/browse-children/${parentId}`,
      );
    },
    updateScope(id: string, scopeConfig: Record<string, unknown>) {
      return request<{
        connector: { id: string; connectorType: string; scopeConfig: Record<string, unknown>; syncStatus: string };
      }>(`/api/connectors/${id}/scope`, {
        method: "PATCH",
        body: JSON.stringify({ scopeConfig }),
      });
    },
  },
  googleOAuth: {
    status() {
      return request<{ configured: boolean; clientId: string | null; baseUrl: string | null }>(
        "/api/oauth/google/status",
      );
    },
    configure(clientId: string, clientSecret: string) {
      return request<{ success: boolean }>("/api/oauth/google/config", {
        method: "PUT",
        body: JSON.stringify({ clientId, clientSecret }),
      });
    },
    authorizeUrl(connectorType?: string) {
      return connectorType
        ? `/api/oauth/google/authorize?connector=${encodeURIComponent(connectorType)}`
        : "/api/oauth/google/authorize";
    },
  },
  zohoOAuth: {
    status() {
      return request<{ configured: boolean; clientId: string | null; baseUrl: string | null; regions: string[] }>(
        "/api/oauth/zoho/status",
      );
    },
    authorizeUrl(region: string) {
      return `/api/oauth/zoho/authorize?region=${encodeURIComponent(region)}`;
    },
  },
  identities: {
    listForUser(userId: string) {
      return request<{ identities: ProviderIdentity[] }>(`/api/identities/user/${userId}`);
    },
    connect(data: { userId: string; provider: string; providerUserId: string; providerEmail?: string | null }) {
      return request<{ identity: ProviderIdentity }>("/api/identities", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    disconnect(userId: string, provider: string) {
      return request<{ success: boolean }>(`/api/identities/user/${userId}/provider/${provider}`, {
        method: "DELETE",
      });
    },
  },
  users: {
    list() {
      return request<{ users: User[] }>("/api/users");
    },
    create(data: {
      name: string;
      email?: string | null;
      whatsappNumber?: string | null;
      description?: string | null;
      type?: string;
      role?: string | null;
      reportsTo?: string | null;
      allowedTools?: string[] | null;
      slackChannelIds?: string[] | null;
      whatsappGroupJids?: string[] | null;
      isWhatsappFallback?: boolean;
    }) {
      return request<{ user: User; verificationSent?: boolean }>("/api/users", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    update(
      id: string,
      data: {
        name?: string;
        email?: string | null;
        whatsappNumber?: string | null;
        description?: string | null;
        role?: string | null;
        authRole?: "admin" | "member";
        reportsTo?: string | null;
        allowedTools?: string[] | null;
        slackChannelIds?: string[] | null;
        whatsappGroupJids?: string[] | null;
        isWhatsappFallback?: boolean;
      },
    ) {
      return request<{ user: User; verificationSent?: boolean }>(`/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    resendVerification(id: string) {
      return request<{ success: boolean; sent: boolean }>(`/api/users/${id}/verification`, {
        method: "POST",
      });
    },
    remove(id: string) {
      return request<{ success: boolean }>(`/api/users/${id}`, {
        method: "DELETE",
      });
    },
    listExternal() {
      return request<{ users: Array<{ id: string; name: string; type: string; created_at: string }> }>(
        "/api/users/external",
      );
    },
    promote(id: string, data: { name: string; email?: string | null; role?: string | null }) {
      return request<{ user: User; verificationSent?: boolean }>(`/api/users/${id}/promote`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
  },
  scheduledTasks: {
    async list() {
      const res = await request<{ tasks: ScheduledTaskListItem[] }>("/api/scheduled-tasks");
      return res.tasks;
    },
    async pause(id: string) {
      const res = await request<{ task: ScheduledTaskListItem }>(`/api/scheduled-tasks/${id}/pause`, {
        method: "POST",
      });
      return res.task;
    },
    async resume(id: string) {
      const res = await request<{ task: ScheduledTaskListItem }>(`/api/scheduled-tasks/${id}/resume`, {
        method: "POST",
      });
      return res.task;
    },
    remove(id: string) {
      return request<{ success: true }>(`/api/scheduled-tasks/${id}`, {
        method: "DELETE",
      });
    },
    async listRuns(taskId: string) {
      const res = await request<{ runs: AutomationRunItem[] }>(`/api/scheduled-tasks/${taskId}/runs`);
      return res.runs;
    },
    async getRun(taskId: string, runId: string) {
      const res = await request<{ run: AutomationRunItem }>(`/api/scheduled-tasks/${taskId}/runs/${runId}`);
      return res.run;
    },
    async getStepContent(taskId: string) {
      const res = await request<{ stepContent: AutomationStepContentItem[] }>(
        `/api/scheduled-tasks/${taskId}/step-content`,
      );
      return res.stepContent;
    },
    trigger(taskId: string) {
      return request<{ status: string }>(`/api/scheduled-tasks/${taskId}/run`, {
        method: "POST",
      });
    },
  },
  skills: {
    list() {
      return request<{ skills: SkillRecord[] }>("/api/skills");
    },
    get(id: string) {
      return request<{ skill: SkillRecord }>(`/api/skills/${id}`);
    },
    create(data: { name: string; description: string; category: SkillRecord["category"]; body: string; id?: string }) {
      return request<{ skill: SkillRecord }>("/api/skills", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    update(id: string, data: { name: string; description: string; category: SkillRecord["category"]; body: string }) {
      return request<{ skill: SkillRecord }>(`/api/skills/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    remove(id: string) {
      return request<{ success: true }>(`/api/skills/${id}`, { method: "DELETE" });
    },
  },
  mcpServers: {
    async list() {
      const res = await request<{ servers: McpServerRecord[] }>("/api/mcp-servers");
      return res.servers;
    },
    async add(data: {
      displayName: string;
      url: string;
      apiUrl?: string;
      credentials: Record<string, unknown>;
      type?: string;
      mode?: "mcp" | "skill";
    }) {
      const res = await request<{ server: McpServerRecord }>("/api/mcp-servers", {
        method: "POST",
        body: JSON.stringify(data),
      });
      return res.server;
    },
    update(
      id: string,
      data: {
        displayName?: string;
        url?: string;
        apiUrl?: string | null;
        credentials?: Record<string, unknown>;
        mode?: "mcp" | "skill";
      },
    ) {
      return request<void>(`/api/mcp-servers/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    remove(id: string) {
      return request<void>(`/api/mcp-servers/${id}`, { method: "DELETE" });
    },
    testConnection(url: string, credentials: string) {
      return request<{ status: "ok" | "error"; toolCount?: number; error?: string }>(
        "/api/mcp-servers/connection-tests",
        {
          method: "POST",
          body: JSON.stringify({ url, credentials }),
        },
      );
    },
    testConnectionById(serverId: string) {
      return request<{ status: "ok" | "error"; toolCount?: number; error?: string }>(
        `/api/mcp-servers/${serverId}/connection-tests`,
        { method: "POST" },
      );
    },
    listApps(providerId: string, query?: string, limit?: number, after?: string) {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (limit) params.set("limit", String(limit));
      if (after) params.set("after", after);
      const qs = params.toString();
      return request<{ apps: IntegrationApp[]; pageInfo: PageInfo }>(
        `/api/mcp-servers/${providerId}/apps${qs ? `?${qs}` : ""}`,
      );
    },
    createConnection(providerId: string, appId: string, callbackUrl?: string) {
      return request<{ redirectUrl: string }>(`/api/mcp-servers/${providerId}/connections`, {
        method: "POST",
        body: JSON.stringify({ appId, callbackUrl }),
      });
    },
    async listConnections(providerId: string) {
      const res = await request<{ connections: IntegrationConnection[] }>(`/api/mcp-servers/${providerId}/connections`);
      return res.connections;
    },
    removeConnection(providerId: string, connectionId: string) {
      return request<void>(`/api/mcp-servers/${providerId}/connections/${connectionId}`, {
        method: "DELETE",
      });
    },
    updateConnectionAccess(providerId: string, connectionId: string, accessLevel: "personal" | "organization") {
      return request<{ success: true; connection: IntegrationConnection | null }>(
        `/api/mcp-servers/${providerId}/connections/${encodeURIComponent(connectionId)}/access`,
        {
          method: "PATCH",
          body: JSON.stringify({ accessLevel }),
        },
      );
    },
  },
  agentEnvironmentVariables: {
    async list() {
      const res = await request<{ variables: AgentEnvironmentVariableRecord[] }>("/api/agent-environment-variables");
      return res.variables;
    },
    async create(data: { name: string; value: string; isSecret: boolean }) {
      const res = await request<{ variable: AgentEnvironmentVariableRecord }>("/api/agent-environment-variables", {
        method: "POST",
        body: JSON.stringify(data),
      });
      return res.variable;
    },
    async update(id: string, data: { value: string }) {
      const res = await request<{ variable: AgentEnvironmentVariableRecord }>(
        `/api/agent-environment-variables/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify(data),
        },
      );
      return res.variable;
    },
    remove(id: string) {
      return request<{ success: true }>(`/api/agent-environment-variables/${id}`, { method: "DELETE" });
    },
    async replaceShares(id: string, targets: AgentEnvironmentShareTargetInput[]) {
      const res = await request<{ variable: AgentEnvironmentVariableRecord }>(
        `/api/agent-environment-variables/${id}/shares`,
        {
          method: "POST",
          body: JSON.stringify({ targets }),
        },
      );
      return res.variable;
    },
    deleteShare(id: string, shareId: string) {
      return request<{ success: true }>(`/api/agent-environment-variables/${id}/shares/${shareId}`, {
        method: "DELETE",
      });
    },
  },
  entities: {
    get(id: string) {
      return request<{
        entity: EntityDetail;
        sourceRefs: EntitySourceRef[];
      }>(`/api/entities/${id}`);
    },
    relations(id: string) {
      return request<EntityRelationsResponse>(`/api/entities/${id}/relations`);
    },
    relationEvidence(id: string, relationId: string) {
      return request<EntityRelationEvidenceResponse>(`/api/entities/${id}/relations/${relationId}/evidence`);
    },
    timeline(id: string) {
      return request<EntityTimelineResponse>(`/api/entities/${id}/timeline`);
    },
    listShares(id: string) {
      return request<EntitySharesResponse>(`/api/entities/${id}/shares`);
    },
    updateShares(id: string, data: { emails: string[]; shareWithEveryone?: boolean }) {
      return request<EntitySharesResponse>(`/api/entities/${id}/shares`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    revokeShare(id: string, email: string) {
      return request<{ success: boolean }>(`/api/entities/${id}/shares/${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
    },
    mentions(id: string, opts?: { source?: string; since?: string; limit?: number; offset?: number }) {
      const params = new URLSearchParams();
      if (opts?.source) params.set("source", opts.source);
      if (opts?.since) params.set("since", opts.since);
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<{
        mentions: EntityMention[];
        total: number;
        hiddenCount: number;
      }>(`/api/entities/${id}/mentions${qs ? `?${qs}` : ""}`);
    },
    create(data: { name: string; sourceType: string; subtype?: string; aliases?: string[] }) {
      return request<{ entity: EntityListItem }>("/api/entities", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    deleteTentative() {
      return request<{ message: string; count: number }>("/api/entities/tentative", { method: "DELETE" });
    },
    reset(
      categories: string[],
      opts?: { runAfter?: boolean; confirm?: string; dryRun?: boolean; wipeLlmFacts?: boolean },
    ) {
      return request<ResetSubmitResponse>("/api/entities/resets", {
        method: "POST",
        body: JSON.stringify({
          categories,
          runAfter: opts?.runAfter ?? false,
          confirm: opts?.confirm,
          dryRun: opts?.dryRun,
          wipeLlmFacts: opts?.wipeLlmFacts,
        }),
      });
    },
    resetJob(id: string) {
      return request<RebuildJob>(`/api/entities/resets/jobs/${id}`);
    },
    resetJobs() {
      return request<RebuildJobsResponse>("/api/entities/resets/jobs");
    },
    reenrich(
      scope: ReenrichScope,
      opts?: { runAfter?: boolean; confirm?: string; dryRun?: boolean; pendingRebuildId?: string },
    ) {
      return request<ReenrichSubmitResponse>("/api/entities/reenrichments", {
        method: "POST",
        body: JSON.stringify({
          scope,
          runAfter: opts?.runAfter ?? true,
          confirm: opts?.confirm,
          dryRun: opts?.dryRun,
          pendingRebuildId: opts?.pendingRebuildId,
        }),
      });
    },
    reenrichJob(id: string) {
      return request<RebuildJob>(`/api/entities/reenrichments/jobs/${id}`);
    },
    reenrichJobs() {
      return request<RebuildJobsResponse>("/api/entities/reenrichments/jobs");
    },
    stopReenrichJob(id: string) {
      return request<{ message: string; job: RebuildJob }>(`/api/entities/reenrichments/jobs/${id}`, {
        method: "DELETE",
      });
    },
    rebuild(pendingRebuildId: string) {
      return request<RebuildSubmitResponse>("/api/entities/rebuilds", {
        method: "POST",
        body: JSON.stringify({ pendingRebuildId }),
      });
    },
    rebuildJob(id: string) {
      return request<RebuildJob>(`/api/entities/rebuilds/jobs/${id}`);
    },
    rebuildJobs() {
      return request<RebuildJobsResponse>("/api/entities/rebuilds/jobs");
    },
    cancelPendingRebuild(pendingRebuildId: string) {
      return request<void>(`/api/entities/rebuilds/pending/${pendingRebuildId}`, {
        method: "DELETE",
      });
    },
    update(id: string, data: { name?: string; sourceType?: string; status?: string; aliases?: string[] }) {
      return request<{ entity: EntityListItem }>(`/api/entities/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    remove(id: string) {
      return request<{ success: boolean }>(`/api/entities/${id}`, { method: "DELETE" });
    },
    list(opts?: {
      type?: string;
      source?: string;
      search?: string;
      sort?: string;
      limit?: number;
      offset?: number;
      includeSystem?: boolean;
    }) {
      const params = new URLSearchParams();
      if (opts?.type) params.set("type", opts.type);
      if (opts?.source) params.set("source", opts.source);
      if (opts?.search) params.set("search", opts.search);
      if (opts?.sort) params.set("sort", opts.sort);
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      if (opts?.includeSystem) params.set("includeSystem", "true");
      const qs = params.toString();
      return request<{
        entities: EntityListItem[];
        total: number;
      }>(`/api/entities${qs ? `?${qs}` : ""}`);
    },
  },
  entityReview: {
    list(opts?: { limit?: number; offset?: number; search?: string }) {
      const params = new URLSearchParams();
      // `limit=0` is a meaningful value (count-only mode) — send it explicitly.
      if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const search = opts?.search?.trim();
      if (search) params.set("q", search);
      const qs = params.toString();
      return request<EntityReviewListResponse>(`/api/entity-review${qs ? `?${qs}` : ""}`);
    },
    get(id: string) {
      return request<EntityReviewDetailResponse>(`/api/entity-review/${id}`);
    },
    confirm(id: string, body: { candidateGeneratedAt: string; mergeIntoEntityId?: string }) {
      return request<EntityReviewConfirmResult>(`/api/entity-review/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    reject(id: string, body: { candidateGeneratedAt: string; rejectAgainstEntityId?: string }) {
      return request<EntityReviewRejectResult>(`/api/entity-review/${id}/reject`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  },
  usage: {
    me(opts?: { period?: "weekly" | "monthly" | "quarterly"; date?: string }) {
      const params = new URLSearchParams();
      if (opts?.period) params.set("period", opts.period);
      if (opts?.date) params.set("date", opts.date);
      const qs = params.toString();
      return request<{
        period: { from: string; to: string; type: "weekly" | "monthly" | "quarterly" };
        messages: { total: number; by_platform: { platform: string; count: number }[] };
        spend: { total_cost_usd: number };
        skills: { total: number; by_skill: { name: string; count: number }[] };
        daily_breakdown: { date: string; messages: number; skills: number }[];
      }>(`/api/usage/me${qs ? `?${qs}` : ""}`);
    },
    summary(opts?: { period?: "weekly" | "monthly" | "quarterly"; date?: string }) {
      const params = new URLSearchParams();
      if (opts?.period) params.set("period", opts.period);
      if (opts?.date) params.set("date", opts.date);
      const qs = params.toString();
      return request<{
        period: { from: string; to: string; type: "weekly" | "monthly" | "quarterly" };
        messages: { total: number; by_platform: { platform: string; count: number }[] };
        spend: { total_cost_usd: number };
        skills: { total: number; by_skill: { name: string; count: number }[] };
        by_user: {
          userId: string;
          userName: string | null;
          userType: string;
          messageCount: number;
          costUsd: number;
          skillCount: number;
          lastRunAt: string | null;
        }[];
        by_group: {
          workspaceKey: string;
          name: string;
          platform: "slack" | "whatsapp";
          messageCount: number;
          skillCount: number;
          lastRunAt: string | null;
        }[];
      }>(`/api/usage/summary${qs ? `?${qs}` : ""}`);
    },
  },
  workspace: {
    summary() {
      return request<WorkspaceSummary>("/api/workspace/summary");
    },

    // List directory contents
    async listFiles(scope: WorkspaceScope, path: string): Promise<{ files: FileMetadata[] }> {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("path", path);
      return request<{ files: FileMetadata[] }>(`/api/workspace/files?${params.toString()}`);
    },

    // Get file content (text or metadata for binary)
    async getFileContent(
      scope: WorkspaceScope,
      path: string,
    ): Promise<{ content: string; isText: boolean; size: number; mimeType: string | null }> {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("path", path);
      return request<{ content: string; isText: boolean; size: number; mimeType: string | null }>(
        `/api/workspace/files/content?${params.toString()}`,
      );
    },

    // Save file content
    async saveFile(scope: WorkspaceScope, path: string, content: string): Promise<{ success: boolean }> {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("path", path);
      return request<{ success: boolean }>(`/api/workspace/files/content?${params.toString()}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
    },

    // Upload file
    async uploadFile(scope: WorkspaceScope, path: string, formData: FormData): Promise<{ success: boolean }> {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("path", path);
      return request<{ success: boolean }>(`/api/workspace/files?${params.toString()}`, {
        method: "POST",
        body: formData,
      });
    },

    // Create folder
    async createFolder(scope: WorkspaceScope, path: string): Promise<{ success: boolean }> {
      return request<{ success: boolean }>(`/api/workspace/folders?scope=${scope}`, {
        method: "POST",
        body: JSON.stringify({ path }),
      });
    },

    // Create empty file
    async createFile(scope: WorkspaceScope, path: string): Promise<{ success: boolean }> {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("path", path);
      return request<{ success: boolean }>(`/api/workspace/files/content?${params.toString()}`, {
        method: "PUT",
        body: JSON.stringify({ content: "" }),
      });
    },

    // Delete file or folder
    async deleteFile(scope: WorkspaceScope, path: string): Promise<{ success: boolean }> {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("path", path);
      return request<{ success: boolean }>(`/api/workspace/files?${params.toString()}`, {
        method: "DELETE",
      });
    },

    // Rename file or folder
    async renameFile(scope: WorkspaceScope, oldPath: string, newPath: string): Promise<{ success: boolean }> {
      return request<{ success: boolean }>(`/api/workspace/files/rename?scope=${scope}`, {
        method: "PATCH",
        body: JSON.stringify({ oldPath, newPath }),
      });
    },

    // Search files recursively
    async searchFiles(scope: WorkspaceScope, query: string): Promise<{ files: FileMetadata[] }> {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("q", query);
      return request<{ files: FileMetadata[] }>(`/api/workspace/files/search?${params.toString()}`);
    },

    // Download file (triggers browser download for all file types without navigating away)
    downloadFile(scope: WorkspaceScope, path: string): void {
      const params = new URLSearchParams();
      params.set("scope", scope);
      params.set("path", path);
      params.set("download", "true");
      const a = document.createElement("a");
      a.href = `/api/workspace/files/content?${params.toString()}`;
      a.download = path.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
  },
};
