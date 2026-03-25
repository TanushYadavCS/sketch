/**
 * Typed API client for the control plane backend.
 * All methods throw on non-2xx responses with the standard error shape.
 */

import type { SkillCategory } from "@/lib/skills-data";
import type { FileMetadata, IntegrationApp, IntegrationConnection, McpServerRecord, PageInfo } from "@sketch/shared";

export type WorkspaceScope = "personal" | "org";

export interface ApiError {
  error: { code: string; message: string };
}

export interface User {
  id: string;
  name: string;
  email: string | null;
  email_verified_at: string | null;
  slack_user_id: string | null;
  whatsapp_number: string | null;
  description: string | null;
  type: string;
  role: string | null;
  reports_to: string | null;
  created_at: string;
}

export interface ScheduledTaskListItem {
  id: string;
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  threadTs: string | null;
  prompt: string;
  scheduleType: "cron" | "interval" | "once";
  scheduleValue: string;
  timezone: string;
  sessionMode: "fresh" | "persistent" | "chat";
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
    const body = (await res.json().catch(() => ({ error: { code: "UNKNOWN", message: res.statusText } }))) as ApiError;
    throw new Error(body.error.message);
  }

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

export interface SetupStatus {
  completed: boolean;
  currentStep: number;
  adminEmail: string | null;
  orgName: string | null;
  botName: string;
  slackConnected: boolean;
  llmConnected: boolean;
  llmProvider: "anthropic" | "bedrock" | null;
  managedUrl?: string;
}

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
  sourceUpdatedAt: string | null;
  hasSummary: boolean;
  accessScope: "restricted" | "unrestricted";
  accessCount: number | null;
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
}

export interface FileAccessMember {
  email: string;
  userName: string | null;
  userId: string | null;
  source: "scope" | "file";
  mapped: boolean;
}

/** A file returned by the paginated all-files endpoint. */
export type UnifiedFile = ConnectorFile;

/** A result from hybrid search (FTS5 + vector). */
export interface SearchResult {
  id: string;
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
}

export interface FileAccess {
  scope: "restricted" | "unrestricted";
  members: FileAccessMember[];
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

export const api = {
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
        return request<{ success: boolean }>("/api/auth/magic-link", {
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
  email: {
    configure(data: { host: string; port: number; user: string; pass: string; from: string; secure: boolean }) {
      return request<{ success: boolean }>("/api/channels/email/config", {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    disconnect() {
      return request<{ success: boolean }>("/api/channels/email/config", { method: "DELETE" });
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
      return request<{ orgName: string | null; botName: string }>("/api/settings/identity");
    },
    searchConfig() {
      return request<{ geminiApiKeyConfigured: boolean; enrichmentEnabled: number }>("/api/settings/search");
    },
    updateSearchConfig(data: { geminiApiKey?: string | null; enrichmentEnabled?: boolean }) {
      return request<{ geminiApiKeyConfigured: boolean; enrichmentEnabled: number }>("/api/settings/search", {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    runEnrichment() {
      return request<{ success: boolean; message: string }>("/api/settings/search/enrichments", {
        method: "POST",
      });
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
    sync(id: string) {
      return request<{ sync: { connectorId: string; status: string } }>(`/api/connectors/${id}/syncs`, {
        method: "POST",
      });
    },
    files(id: string) {
      return request<{ files: ConnectorFile[] }>(`/api/connectors/${id}/files`);
    },
    allFiles(opts?: { limit?: number; offset?: number; source?: string }) {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      if (opts?.source) params.set("source", opts.source);
      const qs = params.toString();
      return request<{ files: UnifiedFile[]; total: number; hasMore: boolean }>(
        `/api/connectors/all-files${qs ? `?${qs}` : ""}`,
      );
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
      return request<{ file: FileContent; access: FileAccess }>(`/api/connectors/files/${fileId}/content`);
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
    authorizeUrl() {
      return "/api/oauth/google/authorize";
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
        reportsTo?: string | null;
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
  },
  workspace: {
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
