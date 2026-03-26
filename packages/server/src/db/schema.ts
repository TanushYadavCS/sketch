import type { Generated } from "kysely";

export interface UsersTable {
  id: string;
  name: string;
  email: string | null;
  email_verified_at: string | null;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  description: string | null;
  type: Generated<string>;
  role: string | null;
  reports_to: string | null;
  created_at: Generated<string>;
}

export interface ChannelsTable {
  id: string;
  slack_channel_id: string;
  name: string;
  type: string;
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
  onboarding_completed_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ConnectorConfigsTable {
  id: string;
  connector_type: string;
  auth_type: string;
  credentials: string;
  scope_config: Generated<string>;

  sync_status: Generated<string>;
  sync_cursor: string | null;
  last_synced_at: string | null;
  error_message: string | null;
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
  tags: string | null;
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
}

export interface OutreachMessagesTable {
  id: string;
  requester_user_id: string;
  recipient_user_id: string;
  message: string;
  task_context: string | null;
  response: string | null;
  status: Generated<string>;
  platform: string;
  channel_id: string | null;
  message_ref: string | null;
  requester_platform: string;
  requester_channel: string;
  requester_thread_ts: string | null;
  created_at: Generated<string>;
  responded_at: string | null;
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
  email_verification_tokens: EmailVerificationTokensTable;
  magic_link_tokens: MagicLinkTokensTable;
  mcp_servers: McpServersTable;
  chat_sessions: ChatSessionsTable;
  scheduled_tasks: ScheduledTasksTable;
  outreach_messages: OutreachMessagesTable;
  agent_runs: AgentRunsTable;
  tool_calls: ToolCallsTable;
}
