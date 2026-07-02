/**
 * Integration registry — defines metadata for all available integrations.
 *
 * Designed for extensibility: add a new integration by adding an entry here.
 * The registry is the single source of truth for integration display info,
 * auth requirements, and scope configuration shapes.
 *
 * Today: 4 connectors. Tomorrow: 50+. This registry scales to both.
 */

export type IntegrationType =
  | "google_drive"
  | "google_calendar"
  | "gmail"
  | "outlook"
  | "teams"
  | "clickup"
  | "notion"
  | "linear"
  | "fireflies"
  | "otter"
  | "zoho_crm";

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
  oauthClientCredentialUrl?: string;
  /** Step-by-step instructions for connecting. */
  connectSteps: string[];
  oauthClientSetupSteps?: string[];
  /** Scope picker type for the connect/manage dialog. */
  scopeType: "none" | "flat" | "nested" | "tree";
  /** Noun for scope items in the picker (pages, spaces, folders). */
  scopeItemNoun?: string;
  /** Scope config key for flat generic pickers. Defaults to rootPages. */
  scopeConfigKey?: string;
  /**
   * true  = each user holds their own credential row (per-user); any authenticated user can add it.
   * false = a single org-wide credential drives sync for everyone (admin-only).
   */
  perUserAuth: boolean;
  /** true = admin must populate provider Client ID/Secret in settings before any user can authorize. */
  requiresOAuthClientSetup: boolean;
  /** OAuth-redirect connectors that pick a data center / region before authorizing. */
  regionOptions?: { value: string; label: string }[];
}

const MICROSOFT_OAUTH_AUTH_FIELDS: AuthField[] = [
  {
    key: "client_id",
    label: "Application (client) ID",
    type: "text",
    placeholder: "00000000-0000-0000-0000-000000000000",
    helpText: "From App registrations > Overview. Use Application (client) ID, not Object ID.",
  },
  {
    key: "tenant",
    label: "Tenant",
    type: "text",
    placeholder: "common",
    helpText: "Use a directory ID, verified domain, or tenant alias such as common.",
  },
  {
    key: "client_secret",
    label: "Client secret",
    type: "password",
    placeholder: "...",
    helpText: "From Certificates & secrets. Paste the secret Value, not the Secret ID.",
  },
];

const OUTLOOK_MICROSOFT_OAUTH_CLIENT_SETUP_STEPS = [
  "Create or open a Microsoft Entra app registration for the tenant you want Outlook users to sign in with",
  "In Authentication, add the Web redirect URI shown below exactly",
  "In API permissions, add delegated Microsoft Graph permissions: Mail.Read, User.Read, and offline_access",
  "Create a client secret in Certificates & secrets and copy its Value before leaving the page",
  "Paste the Application client ID, tenant, and Client Secret Value here, then connect with Microsoft",
];

const TEAMS_MICROSOFT_OAUTH_CLIENT_SETUP_STEPS = [
  "Create or open a Microsoft Entra app registration for the tenant you want Teams users to sign in with",
  "In Authentication, add the Web redirect URI shown below exactly",
  "In API permissions, add delegated Microsoft Graph permissions: Calendars.Read, OnlineMeetings.Read, OnlineMeetingTranscript.Read.All, OnlineMeetingRecording.Read.All, User.Read, and offline_access",
  "Have a tenant admin grant admin consent for transcript and recording permissions if your tenant requires it",
  "Create a client secret in Certificates & secrets and copy its Value before leaving the page",
  "Paste the Application client ID, tenant, and Client Secret Value here, then connect with Microsoft",
];

const MICROSOFT_ENTRA_APP_REGISTRATIONS_URL =
  "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";

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
    type: "gmail",
    name: "Gmail",
    description: "Email messages and threads",
    category: "Communication",
    color: "#EA4335",
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
    scopeLabel: "mailbox",
    scopeType: "none",
    itemNoun: "emails",
    credentialUrl: "https://console.cloud.google.com/apis/credentials",
    connectSteps: [
      "Create an OAuth 2.0 Client in Google Cloud Console",
      "Enable the Gmail API for your project",
      "Add the redirect URI shown below to your OAuth client",
      "Paste the Client ID and Client Secret, then connect with Google",
    ],
    perUserAuth: true,
    requiresOAuthClientSetup: true,
  },
  {
    type: "google_calendar",
    name: "Google Calendar",
    description: "Calendar events and meetings",
    category: "Calendar",
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
    scopeLabel: "calendars",
    scopeType: "flat",
    scopeItemNoun: "calendars",
    scopeConfigKey: "calendarIds",
    itemNoun: "events",
    credentialUrl: "https://console.cloud.google.com/apis/credentials",
    connectSteps: [
      "Create an OAuth 2.0 Client in Google Cloud Console",
      "Enable the Google Calendar API for your project",
      "Add the redirect URI shown below to your OAuth client",
      "Paste the Client ID and Client Secret, then connect with Google",
    ],
    perUserAuth: true,
    requiresOAuthClientSetup: true,
  },
  {
    type: "outlook",
    name: "Outlook",
    description: "Microsoft 365 email messages and threads",
    category: "Communication",
    color: "#0078D4",
    authType: "oauth",
    oauthRedirect: true,
    authFields: MICROSOFT_OAUTH_AUTH_FIELDS,
    scopeLabel: "mailbox",
    scopeType: "none",
    itemNoun: "emails",
    credentialUrl: "https://learn.microsoft.com/en-us/graph/permissions-reference",
    oauthClientCredentialUrl: MICROSOFT_ENTRA_APP_REGISTRATIONS_URL,
    connectSteps: [
      "Sign in with your Microsoft account",
      "Authorize read-only access to your Outlook mailbox",
      "Inbox and sent messages sync automatically after authorization",
    ],
    oauthClientSetupSteps: OUTLOOK_MICROSOFT_OAUTH_CLIENT_SETUP_STEPS,
    perUserAuth: true,
    requiresOAuthClientSetup: false,
  },
  {
    type: "teams",
    name: "Microsoft Teams",
    description: "Meeting transcripts and recording links",
    category: "Meetings",
    color: "#6264A7",
    authType: "oauth",
    oauthRedirect: true,
    authFields: MICROSOFT_OAUTH_AUTH_FIELDS,
    scopeLabel: "meetings",
    scopeType: "none",
    itemNoun: "transcripts",
    credentialUrl: "https://learn.microsoft.com/en-us/graph/permissions-reference",
    oauthClientCredentialUrl: MICROSOFT_ENTRA_APP_REGISTRATIONS_URL,
    connectSteps: [
      "Sign in with your Microsoft account",
      "Authorize read-only calendar and Teams meeting access",
      "A tenant admin may need to grant consent for transcript and recording permissions",
    ],
    oauthClientSetupSteps: TEAMS_MICROSOFT_OAUTH_CLIENT_SETUP_STEPS,
    perUserAuth: true,
    requiresOAuthClientSetup: false,
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
  {
    type: "otter",
    name: "Otter",
    description: "Meeting transcripts from Otter",
    category: "Meetings",
    color: "#1264FF",
    authType: "api_key",
    authFields: [
      {
        key: "email",
        label: "Otter email",
        type: "text",
        placeholder: "you@example.com",
        helpText: "Use the email address on the Otter account that can access the transcripts.",
      },
      {
        key: "password",
        label: "Otter password",
        type: "password",
        placeholder: "Otter password",
        helpText: "If this account uses Google or SSO sign-in, create or reset an Otter password in Otter first.",
      },
    ],
    scopeLabel: "meetings",
    scopeType: "none",
    itemNoun: "transcripts",
    credentialUrl: "https://help.otter.ai/hc/en-us/articles/360047845154-Change-or-reset-your-password",
    connectSteps: [
      "Enter the Otter email and password for the account that owns or can access the transcripts",
      "If the account uses Google or SSO sign-in, create or reset an Otter password first",
      "Sketch validates the Otter session and syncs recent owned and shared transcripts",
    ],
    perUserAuth: true,
    requiresOAuthClientSetup: false,
  },
  {
    type: "zoho_crm",
    name: "Zoho CRM",
    description: "Accounts, contacts, deals, and activities",
    category: "CRM",
    color: "#E42527",
    authType: "oauth",
    oauthRedirect: true,
    authFields: [],
    scopeLabel: "modules",
    scopeType: "none",
    itemNoun: "records",
    credentialUrl: "https://www.zoho.com/crm/developer/docs/api/v6/",
    connectSteps: [
      "Select your Zoho data center (region)",
      "Sign in to Zoho and authorize read access to your CRM",
      "Accounts, contacts, deals, and activities sync automatically",
    ],
    perUserAuth: false,
    requiresOAuthClientSetup: false,
    regionOptions: [
      { value: "com", label: "United States (.com)" },
      { value: "eu", label: "Europe (.eu)" },
      { value: "in", label: "India (.in)" },
      { value: "com.au", label: "Australia (.com.au)" },
      { value: "jp", label: "Japan (.jp)" },
      { value: "ca", label: "Canada (.ca)" },
      { value: "sa", label: "Saudi Arabia (.sa)" },
    ],
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
