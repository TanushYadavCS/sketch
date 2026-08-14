import type { AutomationExecutionMode } from "@sketch/shared";
import type { ColumnType, Generated } from "kysely";

export interface UsersTable {
  id: string;
  name: string;
  email: string | null;
  email_verified_at: string | null;
  password_hash: string | null;
  auth_role: Generated<string>;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  whatsapp_lid: Generated<string | null>;
  whatsapp_lid_attempted_at: Generated<string | null>;
  whatsapp_lid_checked_at: Generated<string | null>;
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
  index_enabled: Generated<number>;
  slice_gap_minutes: number | null;
  slice_max_age_minutes: number | null;
  slice_max_messages: number | null;
  chunk_window_messages: number | null;
  chunk_window_tokens: number | null;
  chunk_min_messages: number | null;
  chunk_target_messages: number | null;
  chunk_max_messages: number | null;
  chunk_max_tokens: number | null;
  chunk_tick_minutes: number | null;
  chunk_idle_close_hours: number | null;
  chunk_provisional_refresh_messages: number | null;
  chunk_model: string | null;
  chunk_reasoning_effort: string | null;
  chunk_burst_threshold_messages: number | null;
  chunk_topic_registry_cap: number | null;
  chunk_group_worker_pool: number | null;
  chunk_last_llm_attempt_at: string | null;
  chunker_mode: Generated<string>;
  chunker_conversion_claim: string | null;
  chunker_conversion_claimed_at: string | null;
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
  slack_team_id: Generated<string | null>;
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
  microsoft_oauth_client_id: string | null;
  microsoft_oauth_client_secret: string | null;
  microsoft_oauth_tenant: string | null;
  gemini_api_key: string | null;
  embedding_provider: string | null;
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
  provider_message_id: string | null;
  thread_id: string | null;
  provider_url: string | null;
  file_name: string;
  file_type: string | null;
  content_category: string;
  content: string | null;
  summary: string | null;
  source: string;
  source_path: string | null;
  source_meta: string | null;
  rollup_group_id: string | null;
  content_hash: string | null;
  is_archived: Generated<number>;
  source_created_at: string | null;
  source_updated_at: string | null;
  is_all_day: Generated<number>;
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

export interface EmailMessageEnvelopesTable {
  indexed_file_id: string;
  connector_config_id: string;
  provider_file_id: string;
  provider_message_id: string;
  thread_id: string | null;
  subject: string | null;
  sent_at: string | null;
  from_json: string;
  to_json: string;
  cc_json: string;
  owner_email: string | null;
  provider_url: string | null;
  updated_at: Generated<string>;
}

export interface EmailSuppressedMessagesTable {
  id: string;
  connector_config_id: string;
  provider_file_id: string;
  provider_message_id: string | null;
  thread_id: string | null;
  reason: string;
  observed_at: string;
}

export interface EmailThreadSummariesTable {
  connector_config_id: string;
  thread_id: string;
  summary: string;
  message_count: number;
  basis_first_sent_at: string | null;
  basis_last_sent_at: string | null;
  basis_hash: string;
  updated_at: Generated<string>;
}

export interface ChunkEmbeddingsTable {
  chunk_id: string;
  embedding: string;
}

export interface FileEmbeddingsTable {
  indexed_file_id: string;
  embedding: string;
}

export interface EntityNameEmbeddingsTable {
  entity_id: string;
  embedding: string;
}

export interface EntityReviewQueueEmbeddingsTable {
  review_id: string;
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
  principal_type: string;
  principal_value: string;
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
  principal_type: string;
  principal_value: string;
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
  kind: Generated<string>;
  client_id: string | null;
  scopes: string | null;
  refresh_token_hash: string | null;
  created_at: Generated<string>;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface OAuthClientsTable {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string;
  grant_types: string;
  scopes: string;
  token_endpoint_auth_method: string;
  created_at: Generated<string>;
}

export interface OAuthAuthorizationCodesTable {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: Generated<string>;
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

export interface LocalDevicesTable {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  token_hash: string;
  prefix: string;
  status: Generated<string>;
  last_seen_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  revoked_at: string | null;
}

export interface LocalDeviceToolCallsTable {
  id: string;
  device_id: string;
  user_id: string;
  tool_name: string;
  command: string;
  cwd: string | null;
  success: number;
  exit_code: number | null;
  timed_out: number;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: number;
  stderr_truncated: number;
  error_message: string | null;
  called_at: Generated<string>;
}

export interface LocalClaudeSessionsTable {
  id: string;
  user_id: string;
  device_id: string;
  tmux_session_name: string;
  title: string;
  cwd: string | null;
  status: string;
  event_token_hash: string;
  origin_platform: string | null;
  origin_context_type: string | null;
  origin_delivery_target: string | null;
  origin_thread_ts: string | null;
  origin_workspace_key: string | null;
  origin_workspace_dir: string | null;
  origin_active_queue_key: string | null;
  origin_conversation_id: number | null;
  origin_provider_thread_id: string | null;
  origin_agent_instructions: string | null;
  origin_agent_allowed_tools: string | null;
  origin_org_context_enabled: number | null;
  last_event_type: string | null;
  last_event_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  ended_at: string | null;
}

export interface LocalClaudeSessionEventsTable {
  id: string;
  session_id: string;
  event_type: string;
  status: string;
  message: string | null;
  payload: string;
  created_at: Generated<string>;
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

export interface CliIntegrationConnectionsTable {
  id: string;
  app_id: string;
  owner_user_id: string;
  credential_variable_id: string;
  account_external_id: string | null;
  account_login: string;
  account_avatar_url: string | null;
  account_type: string | null;
  status: string;
  verified_at: string;
  last_verification_error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
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
  runtime: Generated<string>;
  session_id: string;
  updated_at: Generated<string>;
  archived_at: Generated<string | null>;
}

export interface AgentMessagesTable {
  id: Generated<number>;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  created_at: Generated<string>;
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

export interface ConversationCursorsTable {
  id: Generated<number>;
  conversation_id: number;
  scope_type: string;
  scope_key: string;
  last_seen_message_id: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ConversationMessagesTable {
  id: Generated<number>;
  conversation_id: number;
  provider_message_id: string;
  event_key: string | null;
  sender_jid: Generated<string>;
  sender_name: string;
  sender_user_id: string | null;
  is_bot: Generated<number>;
  addressed_to_sketch: Generated<number>;
  text: Generated<string>;
  attachments: string | null;
  provider_thread_id: string | null;
  provider_parent_message_id: string | null;
  is_thread_reply: Generated<number>;
  provider_timestamp: string | null;
  provider_from_me: Generated<number>;
  received_at: string;
  source: Generated<string>;
  effective_at: Generated<string | null>;
  connection_key: Generated<string | null>;
  backfill_range_id: Generated<string | null>;
  created_at: Generated<string>;
}

export interface WhatsAppInboundEventsTable {
  id: Generated<number>;
  kind: string;
  origin: string;
  event_key: string | null;
  provider_message_id: string | null;
  batch_id: string | null;
  chunk_index: number | null;
  chunk_count: number | null;
  request_session_id: Generated<string | null>;
  backfill_range_id: Generated<string | null>;
  envelope: string;
  received_at: Generated<string>;
  attempts: Generated<number>;
  status: Generated<string>;
  claim_token: string | null;
  claimed_at: string | null;
  next_attempt_at: Generated<string>;
  consumed_at: string | null;
  last_error: string | null;
  created_at: Generated<string>;
}

export interface WhatsAppSessionLeaseTable {
  id: string;
  owner_kind: string;
  owner_token: string;
  generation: number;
  gateway_http_token: string | null;
  host_id: string;
  boot_id: string;
  pid: number;
  pid_start_time: string;
  script_hash: string;
  contract_version: string;
  heartbeat_at: Generated<string>;
  acquired_at: Generated<string>;
  last_live_at: string | null;
  disconnected_at: string | null;
}

export interface OperationalAlertsTable {
  id: string;
  type: string;
  resource_key: string;
  severity: string;
  state: string;
  payload: string;
  first_observed_at: string;
  last_observed_at: string;
  notify_after: string;
  opened_at: string | null;
  resolved_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface OperationalAlertDeliveriesTable {
  id: string;
  alert_id: string;
  recipient_user_id: string;
  channel: string;
  destination_fingerprint: string;
  state: Generated<string>;
  attempts: Generated<number>;
  next_attempt_at: Generated<string>;
  claim_token: string | null;
  claimed_at: string | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  last_error: string | null;
  sent_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WhatsAppConnectionTransitionsTable {
  connection_key: string;
  lease_generation: number;
  socket_generation: number;
  disconnected_at: string | null;
  connected_at: string;
  reconciled_at: string | null;
  created_at: Generated<string>;
}

export interface ConversationSlicesTable {
  id: string;
  conversation_id: number;
  first_message_id: number;
  last_message_id: number;
  started_at: string;
  ended_at: string;
  message_count: number;
  denoised_message_ids: string | null;
  flush_reason: string;
  roster_snapshot: string;
  salience_verdict: string | null;
  salience_signals: string | null;
  salience_claim_token: string | null;
  salience_claimed_at: string | null;
  indexed_file_id: string | null;
  provider_thread_id: string | null;
  status: Generated<string>;
  facts_enriched_content_hash: string | null;
  created_at: Generated<string>;
}

export interface ConversationSliceCursorsTable {
  conversation_id: number;
  last_effective_at: string | null;
  last_message_id: number | null;
  claim_token: string | null;
  claimed_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ConversationSliceStreamCursorsTable {
  conversation_id: number;
  stream_key: string;
  last_message_id: number | null;
  claim_token: string | null;
  claimed_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WhatsAppIdentityCandidatesTable {
  group_jid: string;
  candidate_ref: string;
  participant_jid_ref: string;
  display_name: string | null;
  kept_slice_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_slice_id: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ConversationTopicsTable {
  id: string;
  conversation_id: number;
  name: string;
  one_liner: string | null;
  status: Generated<string>;
  last_activity_at: string;
  canonical_topic_id: string | null;
}

export interface SliceTopicsTable {
  slice_id: string;
  topic_id: string;
}

export interface TopicMergesTable {
  merged_topic_id: string;
  canonical_topic_id: string;
  merged_at: Generated<string>;
  reason: string;
}

export interface ChunkConversionManifestTable {
  id: string;
  group_jid: string;
  artifact_type: string;
  artifact_id: string;
  action: string;
  payload: string;
  created_at: Generated<string>;
  restored_at: string | null;
}

export interface WhatsAppGroupMemberLabelsTable {
  group_jid: string;
  phone_e164: string;
  display_name: string;
  company_name: string | null;
  created_by: string;
  created_at: Generated<string>;
}

export interface WhatsAppGroupParticipantsTable {
  id: Generated<string>;
  group_jid: string;
  observation_key: Generated<string>;
  participant_jid: string;
  phone_e164: string | null;
  lid: string | null;
  admin_role: string | null;
  last_seen_at: Generated<string>;
}

export interface UserWhatsAppLidsTable {
  user_id: string;
  lid: string;
  first_seen_at: Generated<string>;
  last_seen_at: Generated<string>;
}

export interface SlackChannelParticipantsTable {
  channel_id: string;
  slack_user_id: string;
  last_seen_at: Generated<string>;
}

export interface OrganizationDomainsTable {
  id: string;
  domain: string;
  source: string;
  verified_at: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface SlackUserSyncStateTable {
  team_id: string;
  slack_user_id: string;
  name: string | null;
  real_name: string | null;
  display_name: string | null;
  email: string | null;
  profile_team_id: string | null;
  profile_json: string | null;
  is_bot: Generated<number>;
  is_guest: Generated<number>;
  is_stranger: Generated<number>;
  is_restricted: Generated<number>;
  is_ultra_restricted: Generated<number>;
  deleted: Generated<number>;
  classification: string | null;
  classification_source: string | null;
  provider_updated_at: string | null;
  fetched_at: string | null;
  entity_id: string | null;
  entity_created_by_sync: Generated<number>;
  inactive_at: string | null;
  last_roster_seen_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface SlackSyncRunsTable {
  id: string;
  team_id: string;
  run_type: string;
  trigger_key: string;
  pinned_team_id: string;
  status: string;
  stage: string | null;
  heartbeat_at: string | null;
  users_cursor: string | null;
  conversations_cursor: string | null;
  members_cursor: string | null;
  current_channel_id: string | null;
  started_at: Generated<string>;
  completed_at: string | null;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WhatsAppBackfillCheckpointsTable {
  group_jid: string;
  last_fetched_key: string | null;
  status: string;
  live_start_effective_at: Generated<string | null>;
  live_start_message_id: Generated<number | null>;
  graph_last_served_at: Generated<string | null>;
  graph_halted_at: Generated<string | null>;
  graph_halt_reason: Generated<string | null>;
  updated_at: Generated<string>;
}

export interface WhatsAppBackfillRangesTable {
  id: string;
  group_jid: string;
  range_key: string;
  kind: string;
  connection_key: string;
  status: string;
  lower_bound_at: string;
  upper_bound_at: string;
  cursor_remote_jid: string | null;
  cursor_message_id: string | null;
  cursor_from_me: number | null;
  cursor_provider_timestamp: string | null;
  attempts: Generated<number>;
  next_retry_at: string | null;
  last_error: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  request_session_id: string | null;
  request_lease_generation: number | null;
  requested_at: string | null;
  response_deadline_at: string | null;
  terminal_status: string | null;
  last_served_at: string | null;
  graph_cursor_effective_at: Generated<string | null>;
  graph_cursor_message_id: Generated<number | null>;
  graph_completed_at: Generated<string | null>;
  parent_range_id: Generated<string | null>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WhatsAppWindowKeepAlivesTable {
  recipient_user_id: string;
  sent_at: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface ScheduledTasksTable {
  id: string;
  platform: string;
  context_type: string;
  delivery_target: string;
  thread_ts: string | null;
  prompt: string;
  execution_mode: Generated<AutomationExecutionMode>;
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
  origin_platform: string | null;
  origin_conversation_id: string | null;
  origin_provider_thread_id: string | null;
  origin_message_id: number | null;
  steps: string | null;
  edges: string | null;
  output_target: string | null;
  output_platform: string | null;
  output_thread_ts: string | null;
  output_mode: Generated<string>;
  updated_at: Generated<string>;
  revision: Generated<number>;
  last_edited_by: string | null;
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
  triggered_by_user_id: string | null;
}

export interface AutomationTaskSharesTable {
  id: string;
  task_id: string;
  user_id: string;
  granted_by_user_id: string;
  granted_at: Generated<string>;
}

export interface AutomationStepContentTable {
  task_id: string;
  step_id: string;
  content_type: string;
  content: string;
  apps: string | null;
  updated_at: Generated<string>;
}

export interface ScheduledTaskConversationsTable {
  task_id: string;
  conversation_id: string;
  transcript_user_id: string;
  kind: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  last_active_at: Generated<string>;
  archived_at: string | null;
}

export interface AutomationTaskLocksTable {
  task_id: string;
  holder_user_id: string;
  holder_session_id: string;
  generation: number;
  holder_platform: string;
  holder_surface: string;
  holder_conversation_id: string | null;
  acquired_at: Generated<string>;
  updated_at: Generated<string>;
  expires_at: string;
  steal_requester_user_id: string | null;
  steal_requester_session_id: string | null;
  steal_requester_platform: string | null;
  steal_requester_surface: string | null;
  steal_requester_conversation_id: string | null;
  steal_requested_at: string | null;
  steal_expires_at: string | null;
}

export interface GraphPassRunsTable {
  id: string;
  status: string;
  started_at: Generated<string>;
  finished_at: string | null;
  error_message: string | null;
  input_snapshot_json: string;
}

export interface ProjectMintingVerdictsTable {
  id: string;
  company_entity_id: string | null;
  company_name: string;
  file_count: number;
  dossier: string;
  verdict: string;
  model: string;
  prompt_version: string;
  status: Generated<string>;
  superseded_at: string | null;
  counterparty_kind: string | null;
  client_stage: string | null;
  declared_counterparty_kind: string | null;
  declared_client_stage: string | null;
  flags: string | null;
  vote_stats: string | null;
  decided_at: string | null;
  decided_by_user_id: string | null;
  struck_projects: string | null;
  accepted_result: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface CompanyRelationshipDeclarationsTable {
  subject_entity_id: string;
  counterparty_kind: string;
  client_stage: string | null;
  note: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface AgentOutputsTable {
  id: string;
  agent_key: string;
  user_id: string;
  output_date: string;
  period_key: Generated<string | null>;
  source_key: Generated<string>;
  source_label: string | null;
  timezone: string;
  status: string;
  trigger_type: string;
  agent_version: string;
  agent_run_id: string | null;
  masthead_json: string | null;
  raw_payload_json: string | null;
  error_message: string | null;
  generated_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface AgentOutputItemsTable {
  id: string;
  agent_output_id: string;
  task_id: string | null;
  section_key: string;
  title: string;
  summary: string;
  priority: string;
  label: string | null;
  display_ref: string | null;
  action_type: string | null;
  action_label: string | null;
  action_prompt: string | null;
  knowledge_refs_json: string;
  source_url: string | null;
  /** Optional section-specific structured data (e.g. meetings: start time, attendees). */
  structured_payload_json: string | null;
  sort_order: number;
  created_at: Generated<string>;
}

export interface AgentOutputDeliveriesTable {
  id: string;
  agent_output_id: string;
  platform: string;
  target_type: string;
  target_id: string;
  status: string;
  message_refs_json: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WhatsAppProviderEventsTable {
  id: string;
  provider: string;
  dedupe_key: string;
  provider_message_id: string | null;
  provider_conversation_id: string | null;
  event_family: string;
  event_type: string | null;
  status: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  provider_timestamp: string | null;
  raw_payload_json: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WhatsAppTemplateMappingsTable {
  id: string;
  provider: string;
  logical_key: string;
  provider_template_name: string;
  language: Generated<string>;
  status: Generated<string>;
  category: string | null;
  parameter_map_json: string | null;
  last_synced_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface AgentUserConfigsTable {
  agent_key: string;
  user_id: string;
  enabled: Generated<number>;
  schedule_hour: Generated<number>;
  schedule_minute: Generated<number>;
  timezone: string | null;
  max_items_per_section: Generated<number>;
  prefs_json: string | null;
  created_at: Generated<string>;
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
  name_status: Generated<string>;
  source_type: string;
  subtype: string | null;
  aliases: string | null;
  metadata: string | null;
  source_ref_id: string | null;
  status: string;
  project_lifecycle_status: string | null;
  provenance_tier: Generated<string>;
  hotness: number;
  created_at: string;
  updated_at: string;
  ai_brief: string | null;
  share_with_everyone: Generated<number>;
  deleted_at: string | null;
  merged_into_entity_id: string | null;
}

export interface EntityNameProposalsTable {
  id: string;
  entity_id: string;
  source: string;
  value: string;
  normalized_value: string;
  observed_count: Generated<number>;
  first_seen_at: string;
  last_seen_at: string;
  status: Generated<string>;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
}

export interface EntityMergesTable {
  id: string;
  survivor_entity_id: string;
  merged_entity_id: string;
  entity_type: string;
  moves: string;
  merged_by_user_id: string | null;
  group_id: string | null;
  merged_by: string | null;
  merged_at: Generated<string>;
  unmerged_at: string | null;
  unmerged_by_user_id: string | null;
}

export interface EntityShareEmailsTable {
  entity_id: string;
  email: string;
  granted_by_user_id: string;
  granted_at: Generated<string>;
}

export interface CrmObjectSummariesTable {
  connector_config_id: string;
  group_id: string;
  summary: string;
  activity_count: number;
  basis_first_at: string | null;
  basis_last_at: string | null;
  basis_hash: string;
  updated_at: Generated<string>;
}

export interface ContainerClassificationsTable {
  connector_config_id: string;
  container_id: string;
  container_name: string;
  level: string;
  proposed_target: string;
  confidence: string;
  reasoning: string;
  digest_hash: string;
  status: Generated<string>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface EntitySourceRefsTable {
  id: string;
  entity_id: string;
  source: string;
  source_id: string;
  source_url: string | null;
  last_seen_at: string;
}

export interface EntityContactPointsTable {
  id: string;
  entity_id: string;
  kind: string;
  value: string;
  display_value: string | null;
  label: string | null;
  is_primary: Generated<number>;
  source: string;
  connector_config_id: string | null;
  created_by_user_id: string | null;
  verified_at: string | null;
  last_contacted_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface UserEntityLinksTable {
  id: string;
  user_id: string;
  entity_id: string;
  matched_via: string;
  confirmed_by_user_id: string | null;
  created_at: Generated<string>;
}

export interface UserEntityLinkSweepRunsTable {
  id: string;
  run_key: string;
  lease_token: string | null;
  status: string;
  stage: string;
  entity_cursor: string | null;
  user_cursor: string | null;
  heartbeat_at: string | null;
  linked_by_email: Generated<number>;
  linked_by_phone: Generated<number>;
  linked_by_user_creation: Generated<number>;
  provisioned: Generated<number>;
  review_queued: Generated<number>;
  skipped: Generated<number>;
  started_at: Generated<string>;
  completed_at: string | null;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WeeklyMintCandidatesTable {
  review_id: string;
  company_key: string;
  last_grouped_at: string | null;
  dry_streak: Generated<number>;
  scan_days: Generated<number>;
  scan_first_day: string | null;
  scan_last_day: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WeeklyMintRunsTable {
  id: string;
  run_key: string;
  lease_token: string | null;
  status: string;
  stage: string;
  company_cursor: string | null;
  clock_week: string;
  candidates_grouped: Generated<number>;
  verdicts_requested: Generated<number>;
  verdicts_stored: Generated<number>;
  aged_out: Generated<number>;
  heartbeat_at: string | null;
  started_at: Generated<string>;
  completed_at: string | null;
  error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
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
  aux_cost_usd: Generated<number>;
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

export interface EntityProjectBindingsTable {
  id: string;
  entity_id: string;
  source: string;
  container_id: string;
  container_kind: string;
  label: string | null;
  connector_config_id: string | null;
  created_by: string;
  created_at: Generated<string>;
}

export interface EntityProjectMemberOverridesTable {
  id: string;
  entity_id: string;
  indexed_file_id: string;
  mode: string;
  created_by: string;
  created_at: Generated<string>;
}

export interface EntityCreationSuppressionsTable {
  id: string;
  normalized_name: string;
  entity_type: string;
  original_entity_id: string | null;
  reason: string | null;
  created_by: string;
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
  source: string | null;
  source_id: string | null;
  proposed_email: string | null;
  candidate_entity_id: string | null;
  candidate_entity_ids: string | null;
  candidate_user_ids: string | null;
  candidate_score: number | null;
  candidate_reason: string | null;
  candidate_generated_at: string | null;
  pass_reason: string | null;
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
  seed_source: string | null;
  seed_source_id: string | null;
  seed_aliases: string | null;
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
  materialization_input_hash: string | null;
  normalized_subject_name: string | null;
  normalized_mention_name: string | null;
  raw_mention_type: string | null;
  mention_type: string | null;
  feature_corroboration_key: string | null;
  normalization_projected_at: string | null;
  materialized_at: string | null;
  materialization_attempts: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface NormalizationBackfillStateTable {
  id: string;
  status: string;
  cursor_created_at: string | null;
  cursor_id: string | null;
  updated_at: Generated<string>;
}

export interface TasksTable {
  id: string;
  parent_entity_id: string | null;
  parent_source_ref: string | null;
  parent_name: string | null;
  source: string;
  external_ref: string | null;
  title: string;
  normalized_title: string;
  status: string;
  status_raw: string | null;
  status_authority: string;
  assignee_entity_id: string | null;
  assignee_name: string | null;
  proposed_assignee_name: string | null;
  priority: string | null;
  due_at: string | null;
  provenance: string;
  source_task_id: string;
  created_by_user_id: string | null;
  status_changed_at: string | null;
  completed_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  milestone_series_key: string | null;
  source_platform: string | null;
  source_conversation_id: number | null;
  source_provider_thread_id: string | null;
  source_anchor_key: string | null;
  origin_agent_output_id: string | null;
  owner_scope: string | null;
  owner_basis: string | null;
  expiry_state: string | null;
  due_basis: string | null;
  urgency: string | null;
  perishable: Generated<number>;
  raised_at: string | null;
  evidence_quote: string | null;
  confidence: string | null;
  client_entity_id: string | null;
  client_name: string | null;
  status_signal: string | null;
  status_reason: string | null;
  status_confidence: string | null;
  status_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TaskEvidenceTable {
  task_id: string;
  kind: string;
  ref_id: string;
}

export interface TaskMessageEvidenceTable {
  task_id: string;
  conversation_message_id: number;
  source_platform: string;
  source_conversation_id: number;
  source_provider_thread_id: string | null;
  source_anchor_key: string;
  created_at: Generated<string>;
}

export interface TaskCompletionRecommendationsTable {
  id: string;
  task_id: string;
  proposed_status: string;
  review_state: Generated<string>;
  review_code: string;
  evidence_fingerprint: string;
  origin_agent_output_id: string | null;
  rationale: string;
  delivery_count: Generated<number>;
  expires_at: string;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
  review_surface: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TaskCompletionRecommendationEvidenceTable {
  recommendation_id: string;
  conversation_message_id: number;
  created_at: Generated<string>;
}

export interface TaskCompletionRecommendationDeliveriesTable {
  recommendation_id: string;
  agent_output_delivery_id: string;
  created_at: Generated<string>;
}

export type TaskActivityEventKind =
  | "created"
  | "evidence_added"
  | "fields_changed"
  | "status_changed"
  | "completion_proposed"
  | "completion_reviewed";

export type TaskActivityActorType = "user" | "agent" | "system" | "provider";

export type TaskActivitySurface = "daily_brief" | "summarizer" | "web" | "slack" | "whatsapp" | "sync" | "system";

export interface TaskActivityEventsTable {
  id: string;
  task_id: string;
  event_kind: TaskActivityEventKind;
  actor_type: TaskActivityActorType;
  actor_user_id: string | null;
  actor_key: string | null;
  surface: TaskActivitySurface;
  source_agent_output_id: string | null;
  changes_json: string | null;
  evidence_json: string | null;
  dedupe_key: string;
  occurred_at: string;
  created_at: Generated<string>;
}

export interface TaskDurabilityRouteStateTable {
  agent_key: string;
  user_id: string;
  route_id: string;
  source_key: string;
  mode: Generated<string>;
  seed_state: Generated<string>;
  seed_started_at: string | null;
  seed_reviewed_at: string | null;
  incremental_success_at: string | null;
  last_error: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TaskSeedCandidatesTable {
  id: string;
  agent_key: string;
  user_id: string;
  route_id: string;
  source_key: string;
  origin_agent_output_id: string | null;
  origin_agent_output_item_id: string | null;
  title: string;
  normalized_title: string;
  proposed_assignee_name: string | null;
  source_platform: string;
  source_conversation_id: number;
  source_provider_thread_id: string | null;
  source_anchor_key: string;
  evidence_fingerprint: string;
  review_code: string;
  review_state: Generated<string>;
  accepted_task_id: string | null;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WorkCyclesTable {
  id: string;
  scope_entity_id: string | null;
  connector_config_id: string | null;
  source: string;
  external_ref: string;
  name: string;
  sequence: number | null;
  starts_at: string | null;
  ends_at: string | null;
  state: string;
  last_seen_sync_run_id: string | null;
  deleted_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface TaskCycleMembershipsTable {
  id: string;
  task_id: string;
  cycle_id: string;
  assigned_at: Generated<string>;
  removed_at: string | null;
  source_fact_id: string | null;
  created_at: Generated<string>;
}

export interface SubEntitiesTable {
  id: string;
  parent_entity_id: string | null;
  parent_scope_key: string;
  kind: string;
  normalized_name: string;
  display_name: string;
  status: string;
  status_authority: Generated<string>;
  valid_from: Generated<string>;
  valid_to: string | null;
  provenance: string;
  due_at: string | null;
  value_signature: string | null;
  series_key: string | null;
  created_by_user_id: string | null;
  source_fact_id: string | null;
  metadata_json: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface SubEntityEvidenceTable {
  sub_entity_id: string;
  kind: string;
  ref_id: string;
}

export interface QuestionInteractionsTable {
  id: string;
  public_code: string;
  active_scope_key: string | null;
  active_task_key: string | null;
  state: string;
  platform: string;
  conversation_kind: string;
  conversation_id: string;
  thread_id: string | null;
  requester_principal_id: string;
  eligible_responder_principal_ids_json: string;
  session_id: string;
  task_id: string | null;
  agent_run_id: string | null;
  resume_context_json: string;
  expires_at: string;
  answered_at: string | null;
  cancelled_at: string | null;
  expired_at: string | null;
  delivery_ref: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface QuestionInteractionItemsTable {
  interaction_id: string;
  ordinal: number;
  question_id: string;
  prompt: string;
  options_json: string;
  allows_custom_response: number;
  selected_option_id: string | null;
  custom_response: string | null;
  answered_by_principal_id: string | null;
  answered_at: string | null;
}

export interface QuestionInteractionEventsTable {
  id: string;
  interaction_id: string;
  event_type: string;
  inbound_event_id: string | null;
  event_key: string;
  actor_principal_id: string;
  payload_json: string;
  created_at: Generated<string>;
}

export interface QuestionInteractionDeliveriesTable {
  id: string;
  interaction_id: string;
  attempt: number;
  transport: string;
  capability: string;
  status: string;
  provider_message_ref: string | null;
  request_key: string;
  error_code: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WebhookEndpointsTable {
  id: string;
  task_id: string;
  status: string;
  generation: Generated<number>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface WebhookDeliveriesTable {
  id: string;
  endpoint_id: string;
  task_id: string;
  event_id: string;
  payload_hash: string;
  trigger_data: string;
  status: string;
  task_revision: Generated<number>;
  endpoint_generation: Generated<number>;
  run_id: string | null;
  attempt_count: Generated<number>;
  claimed_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  completed_at: string | null;
  error_message: string | null;
}

/**
 * A captured trace of one real `Search` tool call. Written only while dev tools are on.
 */
/**
 * Epoch millis stored as `bigint` on Postgres, whose driver returns int8 as a string to
 * avoid precision loss. Reads must coerce with `Number(...)`; writes stay numbers.
 */
type EpochMs = ColumnType<string | number, number, number>;

export interface DevSearchTraceResultsTable {
  trace_id: string;
  position: number;
  hit_file_id: string;
  result_kind: string;
  file_name: string;
  source: string;
  provider_url: string | null;
  agent_text: string;
  snippet: string | null;
  summary: string | null;
  score: number;
  similarity: number | null;
  /** Epoch millis. `bigint` on Postgres, which the driver hands back as a string. */
  created_at_ms: EpochMs;
}

export interface DevSearchSynthesesTable {
  id: string;
  trace_id: string;
  provider: string;
  model: string;
  prompt: string;
  answer: string | null;
  status: string;
  error: string | null;
  duration_ms: number;
  created_at_ms: EpochMs;
}

export interface DevSearchTracesTable {
  id: string;
  /** Which caller reached `handleSearch`: agent | automation | public_mcp. */
  origin: string;
  user_id: string | null;
  conversation_id: number | null;
  query: string;
  args_json: string;
  principals_json: string;
  stages_json: string;
  status: string;
  error: string | null;
  result_count: Generated<number>;
  duration_ms: Generated<number>;
  started_at: Generated<string>;
}

/** Embeddings of a file's own fields (name, summary), beside its content chunks. */
export interface FileFieldEmbeddingsTable {
  indexed_file_id: string;
  field: string;
  embedding: string;
  source_text: string;
  updated_at: Generated<string>;
}

export interface DB {
  file_field_embeddings: FileFieldEmbeddingsTable;
  dev_search_traces: DevSearchTracesTable;
  dev_search_trace_results: DevSearchTraceResultsTable;
  dev_search_syntheses: DevSearchSynthesesTable;
  question_interactions: QuestionInteractionsTable;
  question_interaction_items: QuestionInteractionItemsTable;
  question_interaction_events: QuestionInteractionEventsTable;
  question_interaction_deliveries: QuestionInteractionDeliveriesTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  users: UsersTable;
  channels: ChannelsTable;
  whatsapp_creds: WhatsAppCredsTable;
  whatsapp_keys: WhatsAppKeysTable;
  whatsapp_inbound_events: WhatsAppInboundEventsTable;
  whatsapp_session_lease: WhatsAppSessionLeaseTable;
  operational_alerts: OperationalAlertsTable;
  operational_alert_deliveries: OperationalAlertDeliveriesTable;
  whatsapp_connection_transitions: WhatsAppConnectionTransitionsTable;
  whatsapp_groups: WhatsAppGroupsTable;
  settings: SettingsTable;
  organization_domains: OrganizationDomainsTable;
  slack_user_sync_state: SlackUserSyncStateTable;
  slack_sync_runs: SlackSyncRunsTable;
  connector_configs: ConnectorConfigsTable;
  indexed_files: IndexedFilesTable;
  email_message_envelopes: EmailMessageEnvelopesTable;
  email_suppressed_messages: EmailSuppressedMessagesTable;
  email_thread_summaries: EmailThreadSummariesTable;
  crm_object_summaries: CrmObjectSummariesTable;
  container_classifications: ContainerClassificationsTable;
  access_scopes: AccessScopesTable;
  access_scope_members: AccessScopeMembersTable;
  connector_files: ConnectorFilesTable;
  document_chunks: DocumentChunksTable;
  document_timeframes: DocumentTimeframesTable;
  chunk_embeddings: ChunkEmbeddingsTable;
  file_embeddings: FileEmbeddingsTable;
  entity_name_embeddings: EntityNameEmbeddingsTable;
  entity_review_queue_embeddings: EntityReviewQueueEmbeddingsTable;
  user_provider_identities: UserProviderIdentitiesTable;
  file_access: FileAccessTable;
  file_share_emails: FileShareEmailsTable;
  email_verification_tokens: EmailVerificationTokensTable;
  magic_link_tokens: MagicLinkTokensTable;
  api_tokens: ApiTokensTable;
  oauth_clients: OAuthClientsTable;
  oauth_authorization_codes: OAuthAuthorizationCodesTable;
  external_mcp_tool_calls: ExternalMcpToolCallsTable;
  local_devices: LocalDevicesTable;
  local_device_tool_calls: LocalDeviceToolCallsTable;
  local_claude_sessions: LocalClaudeSessionsTable;
  local_claude_session_events: LocalClaudeSessionEventsTable;
  agent_environment_variables: AgentEnvironmentVariablesTable;
  agent_environment_variable_shares: AgentEnvironmentVariableSharesTable;
  cli_integration_connections: CliIntegrationConnectionsTable;
  mcp_servers: McpServersTable;
  chat_sessions: ChatSessionsTable;
  agent_messages: AgentMessagesTable;
  conversations: ConversationsTable;
  conversation_cursors: ConversationCursorsTable;
  conversation_messages: ConversationMessagesTable;
  conversation_slices: ConversationSlicesTable;
  conversation_slice_cursors: ConversationSliceCursorsTable;
  conversation_slice_stream_cursors: ConversationSliceStreamCursorsTable;
  conversation_topics: ConversationTopicsTable;
  slice_topics: SliceTopicsTable;
  topic_merges: TopicMergesTable;
  chunk_conversion_manifest: ChunkConversionManifestTable;
  whatsapp_identity_candidates: WhatsAppIdentityCandidatesTable;
  whatsapp_group_member_labels: WhatsAppGroupMemberLabelsTable;
  whatsapp_group_participants: WhatsAppGroupParticipantsTable;
  user_whatsapp_lids: UserWhatsAppLidsTable;
  slack_channel_participants: SlackChannelParticipantsTable;
  whatsapp_backfill_checkpoints: WhatsAppBackfillCheckpointsTable;
  whatsapp_backfill_ranges: WhatsAppBackfillRangesTable;
  whatsapp_window_keepalives: WhatsAppWindowKeepAlivesTable;
  scheduled_tasks: ScheduledTasksTable;
  automation_runs: AutomationRunsTable;
  automation_task_shares: AutomationTaskSharesTable;
  automation_task_locks: AutomationTaskLocksTable;
  automation_step_content: AutomationStepContentTable;
  scheduled_task_conversations: ScheduledTaskConversationsTable;
  graph_pass_runs: GraphPassRunsTable;
  project_minting_verdicts: ProjectMintingVerdictsTable;
  company_relationship_declarations: CompanyRelationshipDeclarationsTable;
  agent_outputs: AgentOutputsTable;
  agent_output_items: AgentOutputItemsTable;
  agent_output_deliveries: AgentOutputDeliveriesTable;
  whatsapp_provider_events: WhatsAppProviderEventsTable;
  whatsapp_template_mappings: WhatsAppTemplateMappingsTable;
  agent_user_configs: AgentUserConfigsTable;
  inbox_messages: InboxMessagesTable;
  entities: EntitiesTable;
  entity_name_proposals: EntityNameProposalsTable;
  entity_merges: EntityMergesTable;
  entity_share_emails: EntityShareEmailsTable;
  entity_source_refs: EntitySourceRefsTable;
  entity_contact_points: EntityContactPointsTable;
  user_entity_links: UserEntityLinksTable;
  user_entity_link_sweep_runs: UserEntityLinkSweepRunsTable;
  weekly_mint_candidates: WeeklyMintCandidatesTable;
  weekly_mint_runs: WeeklyMintRunsTable;
  entity_mentions: EntityMentionsTable;
  agent_runs: AgentRunsTable;
  tool_calls: ToolCallsTable;
  entity_candidates: EntityCandidatesTable;
  entity_review_queue: EntityReviewQueueTable;
  entity_review_evidence: EntityReviewEvidenceTable;
  entity_review_domain_candidates: EntityReviewDomainCandidatesTable;
  entity_alias_rejections: EntityAliasRejectionsTable;
  indexed_file_facts: IndexedFileFactsTable;
  normalization_backfill_state: NormalizationBackfillStateTable;
  tasks: TasksTable;
  task_evidence: TaskEvidenceTable;
  task_message_evidence: TaskMessageEvidenceTable;
  task_completion_recommendations: TaskCompletionRecommendationsTable;
  task_completion_recommendation_evidence: TaskCompletionRecommendationEvidenceTable;
  task_completion_recommendation_deliveries: TaskCompletionRecommendationDeliveriesTable;
  task_activity_events: TaskActivityEventsTable;
  task_durability_route_state: TaskDurabilityRouteStateTable;
  task_seed_candidates: TaskSeedCandidatesTable;
  work_cycles: WorkCyclesTable;
  task_cycle_memberships: TaskCycleMembershipsTable;
  sub_entities: SubEntitiesTable;
  sub_entity_evidence: SubEntityEvidenceTable;
  entity_domains: EntityDomainsTable;
  entity_project_bindings: EntityProjectBindingsTable;
  entity_project_member_overrides: EntityProjectMemberOverridesTable;
  entity_creation_suppressions: EntityCreationSuppressionsTable;
  entity_relationships: EntityRelationshipsTable;
  entity_relationship_evidence: EntityRelationshipEvidenceTable;
}
