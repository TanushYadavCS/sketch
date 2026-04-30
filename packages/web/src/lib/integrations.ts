/**
 * Integration registry — defines metadata for all available integrations.
 *
 * Designed for extensibility: add a new integration by adding an entry here.
 * The registry is the single source of truth for integration display info,
 * auth requirements, and scope configuration shapes.
 *
 * Today: 4 connectors. Tomorrow: 50+. This registry scales to both.
 */

export type IntegrationType = "google_drive" | "clickup" | "notion" | "linear" | "fireflies";

export type AuthFieldType = "text" | "password" | "textarea" | "file";

export interface AuthField {
  key: string;
  label: string;
  type: AuthFieldType;
  placeholder: string;
  helpText?: string;
}

export interface ScopeOption {
  id: string;
  name: string;
  description?: string;
  itemCount?: number;
}

export type SyncStatus = "active" | "syncing" | "error" | "paused" | "pending";
export type EnrichmentStatus = "raw" | "enriched" | "enriching" | "failed";

export interface IntegrationConfig {
  id: string;
  type: IntegrationType;
  syncStatus: SyncStatus;
  fileCount: number;
  enrichedCount: number;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  scopeConfig: Record<string, unknown>;
  createdAt: string;
}

export interface IndexedFile {
  id: string;
  connectorConfigId: string;
  fileName: string;
  fileType: string | null;
  contentCategory: "document" | "structured";
  content: string | null;
  summary: string | null;
  contextNote: string | null;
  enrichmentStatus: EnrichmentStatus;
  tags: string | null;
  source: string;
  sourcePath: string | null;
  providerUrl: string | null;
  sourceUpdatedAt: string | null;
  syncedAt: string;
}

export interface IntegrationDefinition {
  type: IntegrationType;
  name: string;
  description: string;
  category: string;
  /** Hex color for the icon background. */
  color: string;
  /** Auth type for the connect dialog. */
  authType: "api_key" | "oauth" | "service_account";
  /** If true, uses OAuth redirect flow instead of manual credential entry. */
  oauthRedirect?: boolean;
  /** Fields shown in the connect dialog. */
  authFields: AuthField[];
  /** What the scope picker selects (spaces, folders, teams, etc.) */
  scopeLabel: string;
  /** Plural noun for items this integration syncs (tasks, files, pages, issues). */
  itemNoun: string;
  /** External URL for getting credentials. */
  credentialUrl: string;
  /** Step-by-step instructions for connecting. */
  connectSteps: string[];
  /** Scope picker type for the connect/manage dialog. */
  scopeType: "none" | "flat" | "nested" | "tree";
  /** Noun for scope items in the picker (pages, spaces, folders). */
  scopeItemNoun?: string;
  /**
   * true  = each user holds their own credential row (per-user); any authenticated user can add it.
   * false = a single org-wide credential drives sync for everyone (admin-only).
   */
  perUserAuth: boolean;
  /** true = admin must populate provider Client ID/Secret in settings before any user can authorize. */
  requiresOAuthClientSetup: boolean;
}

/**
 * Registry of all available integrations.
 * To add a new integration, add an entry here.
 */
export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    type: "google_drive",
    name: "Google Drive",
    description: "Documents, spreadsheets, and files",
    category: "Storage",
    color: "#4285F4",
    authType: "oauth",
    oauthRedirect: true,
    authFields: [
      {
        key: "client_id",
        label: "Client ID",
        type: "text",
        placeholder: "123456789.apps.googleusercontent.com",
        helpText: "OAuth 2.0 Client ID from Google Cloud Console",
      },
      {
        key: "client_secret",
        label: "Client Secret",
        type: "password",
        placeholder: "GOCSPX-...",
        helpText: "OAuth 2.0 Client Secret",
      },
    ],
    scopeLabel: "folders",
    scopeType: "tree",
    scopeItemNoun: "folders",
    itemNoun: "files",
    credentialUrl: "https://console.cloud.google.com/apis/credentials",
    connectSteps: [
      "Create an OAuth 2.0 Client in Google Cloud Console",
      "Enable the Google Drive API for your project",
      "Add the redirect URI shown below to your OAuth client",
      "Paste the Client ID and Client Secret, then connect with Google",
    ],
    perUserAuth: true,
    requiresOAuthClientSetup: true,
  },
  {
    type: "clickup",
    name: "ClickUp",
    description: "Tasks, docs, and project data",
    category: "Project Management",
    color: "#7B68EE",
    authType: "api_key",
    authFields: [
      {
        key: "api_key",
        label: "API Token",
        type: "password",
        placeholder: "pk_...",
        helpText: "Personal or workspace API token",
      },
    ],
    scopeLabel: "spaces",
    scopeType: "nested",
    scopeItemNoun: "spaces",
    itemNoun: "tasks",
    credentialUrl: "https://app.clickup.com/settings/apps",
    connectSteps: [
      "Go to ClickUp Settings → Apps → API Token",
      "Generate a personal API token",
      "Paste the token below",
    ],
    perUserAuth: false,
    requiresOAuthClientSetup: false,
  },
  {
    type: "notion",
    name: "Notion",
    description: "Pages, databases, and wiki content",
    category: "Knowledge Base",
    color: "#000000",
    authType: "api_key",
    authFields: [
      {
        key: "api_key",
        label: "Integration Token",
        type: "password",
        placeholder: "ntn_...",
        helpText: "Internal integration token with read access",
      },
    ],
    scopeLabel: "pages",
    scopeType: "flat",
    scopeItemNoun: "pages",
    itemNoun: "pages",
    credentialUrl: "https://www.notion.so/my-integrations",
    connectSteps: [
      "Go to notion.so/my-integrations → Create integration",
      'Grant "Read content" capability',
      "Share specific pages/databases with the integration",
      "Paste the integration token below",
    ],
    perUserAuth: false,
    requiresOAuthClientSetup: false,
  },
  {
    type: "linear",
    name: "Linear",
    description: "Issues, projects, and roadmaps",
    category: "Issue Tracking",
    color: "#5E6AD2",
    authType: "api_key",
    authFields: [
      {
        key: "api_key",
        label: "API Key",
        type: "password",
        placeholder: "lin_api_...",
        helpText: "Personal API key with read access",
      },
    ],
    scopeLabel: "teams",
    scopeType: "none",
    itemNoun: "issues",
    credentialUrl: "https://linear.app/settings/api",
    connectSteps: ["Go to Linear Settings → API → Personal API keys", "Create a new API key", "Paste the key below"],
    perUserAuth: false,
    requiresOAuthClientSetup: false,
  },
  {
    type: "fireflies",
    name: "Fireflies",
    description: "Meeting transcripts and summaries",
    category: "Meetings",
    color: "#6C3AFF",
    authType: "api_key",
    authFields: [
      {
        key: "api_key",
        label: "API Key",
        type: "password",
        placeholder: "...",
        helpText: "Fireflies API key from integrations settings",
      },
    ],
    scopeLabel: "meetings",
    scopeType: "none",
    itemNoun: "transcripts",
    credentialUrl: "https://app.fireflies.ai/integrations/custom/fireflies",
    connectSteps: [
      "Go to Fireflies Settings → Integrations → Fireflies API",
      "Generate an API key",
      "Paste the key below",
    ],
    perUserAuth: true,
    requiresOAuthClientSetup: false,
  },
];

/** All integration types where each user holds their own credential. */
export const PER_USER_INTEGRATION_TYPES: IntegrationType[] = INTEGRATIONS.filter((i) => i.perUserAuth).map(
  (i) => i.type,
);

/** Look up an integration definition by type. */
export function getIntegration(type: IntegrationType): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((i) => i.type === type);
}
