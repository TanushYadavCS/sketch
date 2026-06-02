import type { Generated } from "kysely";

export interface UsersTable {
  id: string;
  name: string;
  email: string | null;
  email_verified_at: string | null;
  password_hash: string | null;
  auth_role: Generated<string>;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  description: string | null;
  type: Generated<string>;
  role: string | null;
  reports_to: string | null;
  tool_progress: string | null;
  reasoning_text: Generated<number | null>;
  allowed_tools: string | null;
  timezone: string | null;
  created_at: Generated<string>;
}

export interface ChannelsTable {
  id: string;
  slack_channel_id: string;
  name: string;
  type: string;
  tool_progress: string | null;
  reasoning_text: Generated<number | null>;
  agent_user_id: string | null;
  created_at: Generated<string>;
}

export interface WhatsAppCredsTable {
  id: string;
  creds: string;
  updated_at: Generated<string>;
}

export interface WhatsAppKeysTable {
  type: string;
  key_id: string;
  value: string;
}

export interface WhatsAppGroupsTable {
  jid: string;
  name: string;
  description: string | null;
  tool_progress: string | null;
  reasoning_text: Generated<number | null>;
  agent_user_id: string | null;
  updated_at: Generated<string>;
}

export interface SettingsTable {
  id: string;
  admin_email: string | null;
  admin_password_hash: string | null;
  org_name: string | null;
  bot_name: Generated<string>;
  slack_bot_token: string | null;
  slack_app_token: string | null;
  llm_provider: string | null;
  anthropic_api_key: string | null;
  aws_access_key_id: string | null;
  aws_secret_access_key: string | null;
  aws_region: string | null;
  model_id: string | null;
  jwt_secret: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_password: string | null;
  smtp_from: string | null;
  smtp_secure: Generated<number>;
  google_oauth_client_id: string | null;
  google_oauth_client_secret: string | null;
  gemini_api_key: string | null;
  enrichment_enabled: Generated<number>;
  admin_can_read_all_files: Generated<number>;
  sync_interval_minutes: Generated<number>;
  org_context: string | null;
  sketch_api_key: string | null;
  whatsapp_fallback_agent_id: string | null;
  onboarding_completed_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ConnectorConfigsTable {
  id: string;
  connector_type: string;
  auth_type: string;
  credentials: string;
  credential_source: Generated<string>;
  scope_config: Generated<string>;

  sync_status: Generated<string>;
  sync_cursor: string | null;
  last_synced_at: string | null;
  error_message: string | null;
  browse_cache: string | null;
  credential_hint: string | null;
  created_by: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface IndexedFilesTable {
  id: string;
  connector_config_id: string;
  provider_file_id: string;
  provider_url: string | null;
  file_name: string;
  file_type: string | null;
  content_category: string;
  content: string | null;
  summary: string | null;
  source: string;
  source_path: string | null;
  content_hash: string | null;
  is_archived: Generated<number>;
  source_created_at: string | null;
  source_updated_at: string | null;
  synced_at: string;
  indexed_at: Generated<string>;
  context_note: string | null;
  enrichment_status: Generated<string>;
  access_scope_id: string | null;
  mime_type: string | null;
  embedding_status: Generated<string>;
  summary_status: Generated<string>;
  embedding_attempts: Generated<number>;
  embedding_next_retry_at: string | null;
  summary_attempts: Generated<number>;
  summary_next_retry_at: string | null;
  share_with_everyone: Generated<number>;
}

export interface ChunkEmbeddingsTable {
  chunk_id: string;
  embedding: string;
}

export interface FileEmbeddingsTable {
  indexed_file_id: string;
  embedding: string;
}

export interface DocumentChunksTable {
  id: string;
  indexed_file_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
}

export interface DocumentTimeframesTable {
  id: string;
  indexed_file_id: string;
  start_date: string;
  end_date: string | null;
  context: string | null;
}

export interface AccessScopesTable {
  id: string;
  connector_config_id: string;
  scope_type: string;
  provider_scope_id: string;
  label: string | null;
}

export interface AccessScopeMembersTable {
  access_scope_id: string;
  email: string;
}

export interface ConnectorFilesTable {
  connector_config_id: string;
  indexed_file_id: string;
}

export interface UserProviderIdentitiesTable {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  provider_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  connected_at: Generated<string>;
}

export interface FileAccessTable {
  indexed_file_id: string;
  email: string;
}

export interface FileShareEmailsTable {
  indexed_file_id: string;
  email: string;
  granted_by_user_id: string;
  granted_at: Generated<string>;
}

export interface EmailVerificationTokensTable {
  token: string;
  user_id: string;
  email: string;
  expires_at: string;
  used_at: string | null;
  created_at: Generated<string>;
}

export interface MagicLinkTokensTable {
  token: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
  created_at: Generated<string>;
}

export interface ApiTokensTable {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: Generated<string>;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface ExternalMcpToolCallsTable {
  id: string;
  token_id: string;
  user_id: string;
  tool_name: string;
  success: number;
  duration_ms: number;
  called_at: Generated<string>;
}

export interface AgentEnvironmentVariablesTable {
  id: string;
  user_id: string;
  name: string;
  value: string;
  is_secret: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface AgentEnvironmentVariableSharesTable {
  id: string;
  variable_id: string;
  variable_name: string;
  target_type: string;
  target_id: string;
  created_by: string;
  created_at: Generated<string>;
}

export interface McpServersTable {
  id: string;
  type: string | null;
  slug: string;
  display_name: string;
  url: string;
  api_url: string | null;
  credentials: string;
  mode: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ChatSessionsTable {
  id: Generated<number>;
  workspace_key: string;
  thread_key: Generated<string>;
  session_id: string;
  updated_at: Generated<string>;
}

export interface ConversationsTable {
  id: Generated<number>;
  platform: string;
  kind: string;
  provider_conversation_id: string;
  display_name: string | null;
  last_seen_message_id: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ConversationMessagesTable {
  id: Generated<number>;
  conversation_id: number;
  provider_message_id: string;
  sender_jid: Generated<string>;
  sender_name: string;
  sender_user_id: string | null;
  is_bot: Generated<number>;
  addressed_to_sketch: Generated<number>;
  text: Generated<string>;
  attachments: string | null;
  provider_timestamp: string | null;
  received_at: string;
  created_at: Generated<string>;
}

export interface ScheduledTasksTable {
  id: string;
  platform: string;
  context_type: string;
  delivery_target: string;
  thread_ts: string | null;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  timezone: Generated<string>;
  session_mode: Generated<string>;
  next_run_at: string | null;
  last_run_at: string | null;
  status: Generated<string>;
  created_by: string | null;
  created_at: Generated<string>;
  title: string | null;
  description: string | null;
  steps: string | null;
  edges: string | null;
  output_target: string | null;
  output_platform: string | null;
  output_mode: Generated<string>;
}

export interface AutomationRunsTable {
  id: string;
  task_id: string;
  trigger_data: string | null;
  status: string;
  step_outputs: string | null;
  error_message: string | null;
  started_at: Generated<string>;
  completed_at: string | null;
}

export interface AutomationStepContentTable {
  task_id: string;
  step_id: string;
  content_type: string;
  content: string;
  apps: string | null;
  updated_at: Generated<string>;
}

export interface InboxMessagesTable {
  id: string;
  sender_user_id: string;
  recipient_user_id: string;
  message: string;
  kind: Generated<string>;
  metadata: string | null;
  resolution_mode: Generated<string>;
  platform: string;
  channel_id: string | null;
  message_ref: string | null;
  created_at: Generated<string>;
  consumed_at: string | null;
  resolved_at: string | null;
}

export interface EntitiesTable {
  id: string;
  name: string;
  source_type: string;
  subtype: string | null;
  aliases: string | null;
  metadata: string | null;
  source_ref_id: string | null;
  status: string;
  hotness: number;
  created_at: string;
  updated_at: string;
  ai_brief: string | null;
  share_with_everyone: Generated<number>;
}

export interface EntityShareEmailsTable {
  entity_id: string;
  email: string;
  granted_by_user_id: string;
  granted_at: Generated<string>;
}

export interface EntitySourceRefsTable {
  id: string;
  entity_id: string;
  source: string;
  source_id: string;
  source_url: string | null;
  last_seen_at: string;
}

export interface EntityMentionsTable {
  id: string;
  entity_id: string;
  indexed_file_id: string;
  chunk_index: number | null;
  context_snippet: string | null;
  confidence: string;
  source: string;
  relation: string;
  mentioned_at: string;
}

export interface AgentRunsTable {
  id: Generated<string>;
  trace_id: string;
  span_id: string | null;
  user_id: string | null;
  platform: string;
  context_type: string;
  cost_usd: number;
  is_error: Generated<number>;
  duration_ms: number | null;
  created_at: Generated<string>;
  attributes: Generated<string>;
}

export interface ToolCallsTable {
  id: Generated<number>;
  agent_run_id: string;
  tool_name: string;
  skill_name: string | null;
  attributes: Generated<string>;
  outcome: string | null;
  denial_reason: string | null;
  is_mcp: number | null;
  mcp_server: string | null;
  app_slug: string | null;
  component_key: string | null;
  component_type: string | null;
  auth_type: string | null;
  execution_outcome: string | null;
}

export interface EntityCandidatesTable {
  id: string;
  name: string;
  type: string;
  variations: string | null;
  first_seen_file_id: string;
  seen_file_ids: string;
  seen_count: number;
  promoted_entity_id: string | null;
  created_at: string;
  updated_at: string;
  domain: string | null;
  proposed_company_name: string | null;
  first_observed_by_user_id: string | null;
  observed_person_entity_ids: string | null;
  evidence_file_ids: string | null;
}

export interface EntityDomainsTable {
  id: string;
  entity_id: string | null;
  domain: string;
  kind: string;
  is_primary: number;
  confidence: number;
  source: string;
  created_at: Generated<string>;
}

export interface EntityRelationshipsTable {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  confidence: string;
  confidence_score: number;
  source: string;
  valid_from: Generated<string>;
  valid_to: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface EntityRelationshipEvidenceTable {
  id: string;
  relationship_id: string;
  indexed_file_id: string;
  chunk_index: Generated<number>;
  note: string | null;
  source_fact_id: string | null;
  evidence_key: Generated<string>;
  created_at: Generated<string>;
}

export interface EntityReviewQueueTable {
  id: string;
  proposed_name: string;
  normalized_name: string;
  entity_type: string;
  proposed_email: string | null;
  candidate_entity_id: string | null;
  candidate_score: number | null;
  candidate_reason: string | null;
  candidate_generated_at: string | null;
  first_seen_at: Generated<string>;
  last_seen_at: Generated<string>;
  occurrence_count: Generated<number>;
  status: Generated<string>;
  triggered_by_user_id: string;
  review_started_at: string | null;
  review_started_by: string | null;
  backfill_cursor: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolved_entity_id: string | null;
}

export interface EntityReviewEvidenceTable {
  id: string;
  review_id: string;
  indexed_file_id: string;
  source: string;
  note: string | null;
  seen_at: Generated<string>;
}

export interface EntityReviewDomainCandidatesTable {
  review_id: string;
  domain_candidate_id: string;
  created_at: Generated<string>;
}

export interface EntityAliasRejectionsTable {
  id: string;
  entity_id: string;
  rejected_name: string;
  normalized_rejected_name: string;
  rejected_by: string;
  rejected_at: Generated<string>;
}

export interface IndexedFileFactsTable {
  id: string;
  indexed_file_id: string | null;
  connector_config_id: string | null;
  created_by_user_id: string | null;
  source: string;
  fact_type: string;
  relation: string;
  subject_name: string | null;
  subject_email: string | null;
  subject_source: string | null;
  subject_source_id: string | null;
  context_snippet: string | null;
  raw: string | null;
  fact_key: string;
  last_seen_sync_run_id: string | null;
  deleted_at: string | null;
  content_hash: string | null;
  materialized_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface DB {
  users: UsersTable;
  channels: ChannelsTable;
  whatsapp_creds: WhatsAppCredsTable;
  whatsapp_keys: WhatsAppKeysTable;
  whatsapp_groups: WhatsAppGroupsTable;
  settings: SettingsTable;
  connector_configs: ConnectorConfigsTable;
  indexed_files: IndexedFilesTable;
  access_scopes: AccessScopesTable;
  access_scope_members: AccessScopeMembersTable;
  connector_files: ConnectorFilesTable;
  document_chunks: DocumentChunksTable;
  document_timeframes: DocumentTimeframesTable;
  chunk_embeddings: ChunkEmbeddingsTable;
  file_embeddings: FileEmbeddingsTable;
  user_provider_identities: UserProviderIdentitiesTable;
  file_access: FileAccessTable;
  file_share_emails: FileShareEmailsTable;
  email_verification_tokens: EmailVerificationTokensTable;
  magic_link_tokens: MagicLinkTokensTable;
  api_tokens: ApiTokensTable;
  external_mcp_tool_calls: ExternalMcpToolCallsTable;
  agent_environment_variables: AgentEnvironmentVariablesTable;
  agent_environment_variable_shares: AgentEnvironmentVariableSharesTable;
  mcp_servers: McpServersTable;
  chat_sessions: ChatSessionsTable;
  conversations: ConversationsTable;
  conversation_messages: ConversationMessagesTable;
  scheduled_tasks: ScheduledTasksTable;
  automation_runs: AutomationRunsTable;
  automation_step_content: AutomationStepContentTable;
  inbox_messages: InboxMessagesTable;
  entities: EntitiesTable;
  entity_share_emails: EntityShareEmailsTable;
  entity_source_refs: EntitySourceRefsTable;
  entity_mentions: EntityMentionsTable;
  agent_runs: AgentRunsTable;
  tool_calls: ToolCallsTable;
  entity_candidates: EntityCandidatesTable;
  entity_review_queue: EntityReviewQueueTable;
  entity_review_evidence: EntityReviewEvidenceTable;
  entity_review_domain_candidates: EntityReviewDomainCandidatesTable;
  entity_alias_rejections: EntityAliasRejectionsTable;
  indexed_file_facts: IndexedFileFactsTable;
  entity_domains: EntityDomainsTable;
  entity_relationships: EntityRelationshipsTable;
  entity_relationship_evidence: EntityRelationshipEvidenceTable;
}
