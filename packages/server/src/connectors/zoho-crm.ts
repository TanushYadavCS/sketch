import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { Connector, ConnectorCredentials, OAuthCredentials, PersonEntitySeed, SyncedItem } from "./types";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const PAGE_SIZE = 200;
const CONTENT_LIMIT = 2000;
// Zoho v6 GET records requires an explicit `fields` list, capped at 50 names.
const ZOHO_MAX_FIELDS = 50;

const STANDARD_MODULES = [
  "Accounts",
  "Contacts",
  "Deals",
  "Leads",
  "Tasks",
  "Notes",
  "Calls",
  "Events",
  "Meetings",
] as const;

type StandardModule = (typeof STANDARD_MODULES)[number];

interface ZohoLookup {
  id?: string;
  name?: string;
  email?: string;
}

interface ZohoModuleMetadata {
  api_name?: string;
  module_name?: string;
  plural_label?: string;
  generated_type?: string;
  status?: string;
  visible?: boolean;
  viewable?: boolean;
  api_supported?: boolean;
}

interface ZohoModulesResponse {
  modules?: ZohoModuleMetadata[];
}

interface ZohoRecordsResponse {
  data?: ZohoRecord[];
  info?: { more_records?: boolean };
}

interface ZohoFieldsResponse {
  fields?: Array<{ api_name?: string }>;
}

type ZohoRecord = Record<string, unknown> & {
  id?: string;
  Created_Time?: string;
  Modified_Time?: string;
  Owner?: ZohoLookup | null;
};

type ParentEntity = NonNullable<SyncedItem["parentEntities"]>[number];

export interface DiscoveredZohoModule {
  logicalName: StandardModule;
  apiName: string;
  label: string;
}

interface ZohoRequestOptions {
  headers?: Record<string, string>;
  attempt?: number;
}

function requireOAuthCredentials(credentials: ConnectorCredentials): OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Zoho CRM connector requires OAuth credentials");
  }
  return credentials;
}

function isTokenFresh(credentials: OAuthCredentials): boolean {
  if (!credentials.expires_at) return false;
  return new Date(credentials.expires_at).getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS;
}

function zohoAuthHeader(accessToken: string): string {
  return `Zoho-oauthtoken ${accessToken}`;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLookup(value: unknown): ZohoLookup | null {
  return isRecord(value) ? (value as ZohoLookup) : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function lookupName(value: unknown): string | null {
  const lookup = asLookup(value);
  return lookup?.name?.trim() || lookup?.email?.trim() || null;
}

function lookupId(value: unknown): string | null {
  const lookup = asLookup(value);
  return lookup?.id?.trim() || null;
}

function fieldValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return asNonEmptyString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const values = value.map(fieldValue).filter((item): item is string => Boolean(item));
    return values.length > 0 ? values.join(", ") : null;
  }
  if (isRecord(value)) {
    const named = lookupName(value);
    if (named) return named;
  }
  return null;
}

function titleCase(input: string): string {
  return input
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeModuleApiName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function isModuleUsable(module: ZohoModuleMetadata): boolean {
  // Must be reachable via the records API.
  if (module.api_supported === false) return false;
  if (module.visible === false || module.viewable === false) return false;
  // Zoho's `status` is "visible" | "user_hidden" | "system_hidden" (not "active").
  // Skip modules a user explicitly hid; allow "visible" and "system_hidden"
  // (the latter covers API-accessible backend modules like Notes). The
  // logicalModuleFor allowlist decides which modules we actually sync.
  if (module.status && module.status.toLowerCase() === "user_hidden") return false;
  return Boolean(module.api_name);
}

export function makeProviderFileId(moduleApiName: string, recordId: string): string {
  return `${moduleApiName}:${recordId}`;
}

export function moduleToFileType(moduleApiName: string): string {
  const normalized = normalizeModuleApiName(moduleApiName);
  const known: Record<string, string> = {
    accounts: "crm_account",
    contacts: "crm_contact",
    deals: "crm_deal",
    leads: "crm_lead",
    tasks: "crm_task",
    notes: "crm_note",
    calls: "crm_call",
    events: "crm_event",
    meetings: "crm_meeting",
  };
  return (
    known[normalized] ??
    `crm_${moduleApiName
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/\W+/g, "_")
      .toLowerCase()}`
  );
}

function logicalModuleFor(apiName: string): StandardModule | null {
  const normalized = normalizeModuleApiName(apiName);
  const byName: Record<string, StandardModule> = {
    accounts: "Accounts",
    contacts: "Contacts",
    deals: "Deals",
    leads: "Leads",
    tasks: "Tasks",
    notes: "Notes",
    calls: "Calls",
    events: "Events",
    meetings: "Meetings",
  };
  return byName[normalized] ?? null;
}

async function zohoApiRequest<T>(
  credentials: OAuthCredentials,
  path: string,
  logger?: Logger,
  opts: ZohoRequestOptions = {},
): Promise<T> {
  if (!credentials.api_domain) {
    throw new Error("Zoho CRM credentials are missing api_domain");
  }
  if (!credentials.access_token) {
    throw new Error("Zoho CRM credentials are missing access_token");
  }

  const attempt = opts.attempt ?? 1;
  let response: Response;
  try {
    response = await fetch(`${credentials.api_domain}/crm/v6${path}`, {
      headers: {
        Authorization: zohoAuthHeader(credentials.access_token),
        ...(opts.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      logger?.warn({ err, attempt, waitMs }, "Zoho CRM network error, retrying");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return zohoApiRequest(credentials, path, logger, { ...opts, attempt: attempt + 1 });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Zoho CRM API network error after ${MAX_RETRIES} attempts: ${message}`);
  }

  // 204 (no records) and 304 (If-Modified-Since: nothing changed) both mean
  // "no data" — return an empty payload rather than falling through to the
  // !response.ok throw, which would break incremental sync on unchanged modules.
  if (response.status === 204 || response.status === 304) {
    return {} as T;
  }
  if (response.status === 401) {
    throw new Error("Zoho CRM token is invalid or revoked; reconnect required");
  }
  if (response.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Zoho CRM API rate limited after ${MAX_RETRIES} attempts`);
    }
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "10", 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 10_000;
    logger?.warn({ attempt, waitMs }, "Zoho CRM rate limited, retrying");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return zohoApiRequest(credentials, path, logger, { ...opts, attempt: attempt + 1 });
  }
  if (response.status >= 500 && attempt < MAX_RETRIES) {
    const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
    logger?.warn({ attempt, status: response.status, waitMs }, "Zoho CRM server error, retrying");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return zohoApiRequest(credentials, path, logger, { ...opts, attempt: attempt + 1 });
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoho CRM API failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

export async function validateZohoCrmCredentials(credentials: ConnectorCredentials): Promise<void> {
  const oauth = requireOAuthCredentials(credentials);
  await zohoApiRequest<unknown>(oauth, "/users?type=CurrentUser");
}

export async function discoverStandardModules(
  credentials: OAuthCredentials,
  logger?: Logger,
): Promise<DiscoveredZohoModule[]> {
  const response = await zohoApiRequest<ZohoModulesResponse>(credentials, "/settings/modules", logger);
  const discovered = new Map<StandardModule, DiscoveredZohoModule>();

  for (const module of response.modules ?? []) {
    if (!isModuleUsable(module)) continue;
    const apiName = module.api_name as string;
    const logicalName = logicalModuleFor(apiName);
    if (!logicalName) continue;
    if (discovered.has(logicalName)) continue;
    discovered.set(logicalName, {
      logicalName,
      apiName,
      label: module.plural_label ?? module.module_name ?? apiName,
    });
  }

  return STANDARD_MODULES.flatMap((name) => {
    const module = discovered.get(name);
    return module ? [module] : [];
  });
}

function getRecordName(moduleApiName: string, record: ZohoRecord): string {
  const fullName = [record.First_Name, record.Last_Name].map(fieldValue).filter(Boolean).join(" ");
  const normalized = normalizeModuleApiName(moduleApiName);
  const byModule: Record<string, unknown[]> = {
    accounts: [record.Account_Name, record.Name],
    contacts: [record.Full_Name, fullName, record.Email, record.Name],
    leads: [record.Full_Name, fullName, record.Lead_Name, record.Company, record.Email, record.Name],
    deals: [record.Deal_Name, record.Name, record.Account_Name],
    tasks: [record.Subject, record.Name],
    notes: [record.Note_Title, record.Subject, record.Name],
    calls: [record.Subject, record.Name],
    events: [record.Event_Title, record.Subject, record.Name],
    meetings: [record.Event_Title, record.Subject, record.Name],
  };
  const candidates = [...(byModule[normalized] ?? [record.Name]), record.id];
  return candidates.map(fieldValue).find((value): value is string => Boolean(value)) ?? `${moduleApiName} record`;
}

function sourcePath(orgName: string | undefined, moduleLabel: string): string {
  return ["Zoho CRM", orgName, moduleLabel].filter(Boolean).join(" / ");
}

function importantFields(moduleApiName: string): string[] {
  const normalized = normalizeModuleApiName(moduleApiName);
  const common = ["Owner", "Email", "Phone", "Mobile", "Created_Time", "Modified_Time"];
  const byModule: Record<string, string[]> = {
    accounts: ["Account_Name", "Website", "Industry", "Annual_Revenue", "Account_Type", ...common],
    contacts: ["Full_Name", "First_Name", "Last_Name", "Email", "Title", "Account_Name", "Phone", "Mobile", "Owner"],
    leads: ["Full_Name", "First_Name", "Last_Name", "Company", "Email", "Lead_Status", "Lead_Source", "Phone", "Owner"],
    deals: [
      "Deal_Name",
      "Stage",
      "Amount",
      "Closing_Date",
      "Probability",
      "Expected_Revenue",
      "Account_Name",
      "Contact_Name",
      "Owner",
    ],
    tasks: ["Subject", "Status", "Priority", "Due_Date", "What_Id", "Who_Id", "Owner"],
    notes: ["Note_Title", "Parent_Id", "Owner", "Created_Time", "Modified_Time"],
    calls: ["Subject", "Call_Type", "Call_Start_Time", "Call_Duration", "What_Id", "Who_Id", "Owner"],
    events: ["Event_Title", "Subject", "Start_DateTime", "End_DateTime", "What_Id", "Who_Id", "Owner"],
    meetings: ["Event_Title", "Subject", "Start_DateTime", "End_DateTime", "What_Id", "Who_Id", "Owner"],
  };
  return byModule[normalized] ?? common;
}

export function formatCrmRecordContent(moduleApiName: string, record: ZohoRecord): string {
  const title = getRecordName(moduleApiName, record);
  const lines = [`# ${title} (${titleCase(moduleApiName)})`];
  const seen = new Set<string>();
  const primary: string[] = [];

  for (const key of importantFields(moduleApiName)) {
    const value = fieldValue(record[key]);
    if (!value) continue;
    seen.add(key);
    primary.push(`${titleCase(key)}: ${value}`);
  }

  if (primary.length > 0) {
    lines.push("", primary.join(" | "));
  }

  const description = fieldValue(record.Description) ?? fieldValue(record.Note_Content);
  if (description) {
    seen.add("Description");
    seen.add("Note_Content");
    lines.push("", "## Description", description);
  }

  const customFields = Object.entries(record)
    .filter(([key]) => !seen.has(key))
    .filter(([key]) => key !== "id" && !key.startsWith("$") && !key.includes("__") && !key.endsWith("_Id"))
    .map(([key, value]) => [titleCase(key), fieldValue(value)] as const)
    .filter(([, value]) => Boolean(value))
    .slice(0, 30);

  if (customFields.length > 0) {
    lines.push("", "## Additional Fields", customFields.map(([key, value]) => `${key}: ${value}`).join(" | "));
  }

  const content = lines.join("\n");
  return content.length <= CONTENT_LIMIT ? content : `${content.slice(0, CONTENT_LIMIT - 12).trimEnd()}\n[truncated]`;
}

/**
 * Maps a Zoho record's people (owner, the contact/lead itself, related contact)
 * to person seeds. Intentionally NOT wired into `sync` yet: this phase ingests
 * CRM records as plain structured files only. Retained (and unit-tested) for the
 * forthcoming entity-authority phase, which will seed people/companies with
 * domain authority and cross-source merge rather than naive promotion.
 */
export function extractPeopleFromRecord(moduleApiName: string, record: ZohoRecord): PersonEntitySeed[] {
  const seeds: PersonEntitySeed[] = [];
  const owner = asLookup(record.Owner);
  if (owner?.id && owner.name) {
    seeds.push({
      name: owner.name,
      email: owner.email,
      subtype: "internal",
      source: "zoho_crm",
      sourceId: `user:${owner.id}`,
    });
  }

  const normalized = normalizeModuleApiName(moduleApiName);
  const recordName = getRecordName(moduleApiName, record);
  const email = asNonEmptyString(record.Email);
  if ((normalized === "contacts" || normalized === "leads") && record.id && recordName) {
    seeds.push({
      name: recordName,
      email: email ?? undefined,
      subtype: "external",
      source: "zoho_crm",
      sourceId: makeProviderFileId(moduleApiName, record.id),
    });
  }

  const contact = asLookup(record.Contact_Name);
  if (contact?.id && contact.name) {
    seeds.push({
      name: contact.name,
      email: contact.email,
      subtype: "external",
      source: "zoho_crm",
      sourceId: makeProviderFileId("Contacts", contact.id),
    });
  }

  return seeds;
}

function parentFromLookup(moduleApiName: string, value: unknown, contextSnippet: string): ParentEntity[] {
  const id = lookupId(value);
  if (!id) return [];
  return [{ source: "zoho_crm", sourceId: makeProviderFileId(moduleApiName, id), contextSnippet }];
}

/**
 * Maps a Zoho record's parent links (Deal/Contact -> Account, activity -> parent).
 * Intentionally NOT emitted on synced items yet: with no entities seeded this
 * phase, parent_entity facts could never resolve and the materializer would
 * retry them every sync. Retained (and unit-tested) for the entity-authority
 * phase, which will emit these as typed, authoritative relationships.
 */
export function extractParentEntities(moduleApiName: string, record: ZohoRecord): ParentEntity[] {
  const normalized = normalizeModuleApiName(moduleApiName);
  if (normalized === "deals") {
    return parentFromLookup("Accounts", record.Account_Name, "Deal account");
  }
  if (normalized === "contacts") {
    return parentFromLookup("Accounts", record.Account_Name, "Contact account");
  }
  if (["tasks", "notes", "calls", "events", "meetings"].includes(normalized)) {
    return [
      ...parentFromLookup("Deals", record.What_Id, "CRM activity parent"),
      ...parentFromLookup("Contacts", record.Who_Id, "CRM activity participant"),
      ...parentFromLookup("Contacts", record.Parent_Id, "CRM note parent"),
    ];
  }
  return [];
}

function recordToSyncedItem(module: DiscoveredZohoModule, record: ZohoRecord, orgName?: string): SyncedItem | null {
  if (!record.id) return null;
  const content = formatCrmRecordContent(module.apiName, record);
  return {
    providerFileId: makeProviderFileId(module.apiName, record.id),
    providerUrl: null,
    fileName: getRecordName(module.apiName, record),
    fileType: moduleToFileType(module.apiName),
    contentCategory: "structured",
    content,
    sourcePath: sourcePath(orgName, module.label),
    contentHash: contentHash(
      JSON.stringify({
        content,
        modifiedTime: record.Modified_Time ?? null,
      }),
    ),
    sourceCreatedAt: record.Created_Time ?? null,
    sourceUpdatedAt: record.Modified_Time ?? null,
  };
}

/**
 * Zoho v6 GET records requires an explicit `fields` list. Discover the module's
 * field API names from /settings/fields, always keep the system fields the sync
 * relies on, and cap at Zoho's 50-field limit. Falls back to the curated
 * important-field set if discovery fails or returns nothing.
 */
async function resolveModuleFields(
  credentials: OAuthCredentials,
  moduleApiName: string,
  logger: Logger,
): Promise<string> {
  let names: string[] = [];
  try {
    const response = await zohoApiRequest<ZohoFieldsResponse>(
      credentials,
      `/settings/fields?module=${encodeURIComponent(moduleApiName)}`,
      logger,
    );
    names = (response.fields ?? []).map((f) => f.api_name).filter((n): n is string => Boolean(n));
  } catch (err) {
    logger.warn({ err, module: moduleApiName }, "Zoho CRM field discovery failed; using important fields");
  }
  if (names.length === 0) names = importantFields(moduleApiName);
  // System fields are valid on every CRM module and are required downstream
  // (cursor, change detection, owner seeding), so force them to the front.
  const ordered = [...new Set(["Created_Time", "Modified_Time", "Owner", ...names])];
  return ordered.slice(0, ZOHO_MAX_FIELDS).join(",");
}

async function* syncModule(
  credentials: OAuthCredentials,
  module: DiscoveredZohoModule,
  cursor: string | null,
  logger: Logger,
  orgName?: string,
): AsyncGenerator<SyncedItem> {
  let page = 1;
  let moreRecords = true;
  const headers = cursor ? { "If-Modified-Since": cursor } : undefined;
  const fields = await resolveModuleFields(credentials, module.apiName, logger);

  while (moreRecords) {
    const params = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE), fields });
    const response = await zohoApiRequest<ZohoRecordsResponse>(
      credentials,
      `/${encodeURIComponent(module.apiName)}?${params.toString()}`,
      logger,
      { headers },
    );

    logger.info(
      { module: module.apiName, page, records: (response.data ?? []).length, moreRecords: response.info?.more_records },
      "Zoho CRM module page fetched",
    );

    for (const record of response.data ?? []) {
      const item = recordToSyncedItem(module, record, orgName);
      if (item) yield item;
    }

    moreRecords = response.info?.more_records === true;
    page += 1;
  }
}

export async function refreshZohoCrmTokens(credentials: OAuthCredentials): Promise<OAuthCredentials | null> {
  if (isTokenFresh(credentials)) {
    return null;
  }
  if (!credentials.accounts_server) {
    throw new Error("Zoho CRM credentials are missing accounts_server");
  }
  if (!credentials.refresh_token) {
    throw new Error("Zoho CRM credentials are missing refresh_token");
  }

  const response = await fetch(`${credentials.accounts_server}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 400) {
    const body = await response.text();
    throw new Error(`Zoho CRM refresh token is invalid or revoked; reconnect required: ${body}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoho CRM token refresh failed (${response.status}): ${body}`);
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
    api_domain?: string;
  };

  return {
    ...credentials,
    access_token: tokenData.access_token,
    token_type: tokenData.token_type ?? credentials.token_type,
    api_domain: tokenData.api_domain ?? credentials.api_domain,
    expires_at: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export function createZohoCrmConnector(): Connector {
  return {
    type: "zoho_crm",
    perUserAuth: false,
    requiresOAuthClientSetup: false,

    async validateCredentials(credentials) {
      await validateZohoCrmCredentials(credentials);
    },

    async *sync({ credentials, cursor, logger }) {
      const oauth = requireOAuthCredentials(credentials);
      const modules = await discoverStandardModules(oauth, logger);
      const orgName = typeof oauth.region === "string" ? `Zoho ${oauth.region}` : undefined;
      logger.info(
        { cursor, apiDomain: oauth.api_domain, moduleCount: modules.length, modules: modules.map((m) => m.apiName) },
        "Zoho CRM sync: modules to sync",
      );

      for (const module of modules) {
        logger.info({ module: module.apiName }, "Syncing Zoho CRM module");
        for await (const item of syncModule(oauth, module, cursor, logger, orgName)) {
          yield item;
        }
      }
    },

    async getCursor() {
      return new Date().toISOString();
    },

    async refreshTokens(credentials) {
      return refreshZohoCrmTokens(credentials);
    },
  };
}
