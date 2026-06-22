import { randomUUID } from "node:crypto";
import type { WebChatIntegrationConnectionData } from "@sketch/shared";
import type { IntegrationApp, IntegrationConnection, IntegrationProvider } from "./types";

export interface IntegrationCardCollector {
  collect(card: WebChatIntegrationConnectionData): void;
}

export interface IntegrationLookup {
  query: string;
  reason?: string;
}

export interface IntegrationLookupResult {
  apps: Array<
    IntegrationApp & {
      connected: boolean;
      connectionStatus?: string;
      connectionId?: string | null;
      accountName?: string;
    }
  >;
  cards: WebChatIntegrationConnectionData[];
}

export interface IntegrationProgressEventLike {
  kind: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
}

const CONNECTED_ACCOUNTS_INQUIRY_PATTERNS = [
  /\b(list|show|display|view|see)\b.*\b(connected\s+(accounts|apps|integrations|connections)|connections|accounts)\b/i,
  /\b(what|which)\b.*\b(accounts|apps|integrations|connections)\b.*\bconnected\b/i,
  /\b(what|which)\b.*\bconnected\s+(accounts|apps|integrations|connections)\b/i,
  /^\s*(my\s+)?connected\s+(accounts|apps|integrations|connections)\??\s*$/i,
];

export function isConnectedAccountsInquiry(text: string): boolean {
  const normalized = text.trim();
  return CONNECTED_ACCOUNTS_INQUIRY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function normalizeIntegrationLookup(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function connectionMatchesApp(connection: IntegrationConnection, app: IntegrationApp): boolean {
  const appKeys = [app.id, app.name].map(normalizeIntegrationLookup);
  const connectionKeys = [connection.appId, connection.app?.nameSlug, connection.appName].map(
    normalizeIntegrationLookup,
  );
  return appKeys.some((key) => key && connectionKeys.includes(key));
}

export function isActiveIntegrationConnection(connection: IntegrationConnection): boolean {
  return connection.status === "active" && connection.healthy !== false;
}

function cardId(prefix: string, appId: string): string {
  return `${prefix}-${normalizeIntegrationLookup(appId) || randomUUID()}-${randomUUID()}`;
}

export function connectedCardFromConnection(connection: IntegrationConnection): WebChatIntegrationConnectionData {
  return {
    requestId: cardId("integration-connected", connection.appId),
    appId: connection.appId,
    appName: connection.appName,
    state: "connected",
    ...(connection.icon ? { icon: connection.icon } : {}),
    ...(connection.accountName ? { accountName: connection.accountName } : {}),
    connectionId: connection.id,
  };
}

export function cardFromApp(
  app: IntegrationApp,
  connection: IntegrationConnection | null,
  reason?: string,
): WebChatIntegrationConnectionData {
  if (connection) {
    return {
      requestId: cardId("integration-connected", app.id),
      appId: app.id,
      appName: app.name,
      state: "connected",
      ...(app.icon ? { icon: app.icon } : {}),
      ...(connection.accountName ? { accountName: connection.accountName } : {}),
      connectionId: connection.id,
    };
  }

  return {
    requestId: cardId("integration-connect", app.id),
    appId: app.id,
    appName: app.name,
    state: "connect",
    ...(app.icon ? { icon: app.icon } : {}),
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  };
}

export function dedupeIntegrationCards(cards: WebChatIntegrationConnectionData[]): WebChatIntegrationConnectionData[] {
  const seen = new Set<string>();
  const deduped: WebChatIntegrationConnectionData[] = [];
  for (const card of cards) {
    const key = `${card.state ?? "connect"}:${normalizeIntegrationLookup(card.appId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(card);
  }
  return deduped;
}

function connectionForApp(connections: IntegrationConnection[], app: IntegrationApp): IntegrationConnection | null {
  return (
    connections.find(
      (connection) => connectionMatchesApp(connection, app) && isActiveIntegrationConnection(connection),
    ) ?? null
  );
}

function bestRenderableApps(apps: IntegrationApp[], query: string): IntegrationApp[] {
  if (apps.length === 0) return [];
  const queryKey = normalizeIntegrationLookup(query);
  const exactMatches = apps.filter((app) =>
    [app.id, app.name].map(normalizeIntegrationLookup).some((candidate) => candidate === queryKey),
  );
  if (exactMatches.length === 1) return exactMatches;
  return apps.length === 1 ? apps : [];
}

export async function resolveIntegrationLookup(
  provider: IntegrationProvider,
  connections: IntegrationConnection[],
  lookup: IntegrationLookup,
  limit = 5,
): Promise<IntegrationLookupResult> {
  const result = await provider.listApps(lookup.query, limit, undefined);
  const apps = result.apps.map((app) => {
    const connection = connectionForApp(connections, app);
    return {
      ...app,
      connected: Boolean(connection),
      ...(connection?.status ? { connectionStatus: connection.status } : {}),
      connectionId: connection?.id ?? null,
      ...(connection?.accountName ? { accountName: connection.accountName } : {}),
    };
  });
  const cards = bestRenderableApps(result.apps, lookup.query).map((app) =>
    cardFromApp(app, connectionForApp(connections, app), lookup.reason),
  );
  return { apps, cards };
}

export function connectedIntegrationCards(
  connections: IntegrationConnection[],
  limit = 20,
): WebChatIntegrationConnectionData[] {
  return connections.filter(isActiveIntegrationConnection).slice(0, limit).map(connectedCardFromConnection);
}

function shellFlagValue(command: string, flag: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`${escaped}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s|;&]+))`));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function shellFlagValueAny(command: string, flags: string[]): string | null {
  for (const flag of flags) {
    const value = shellFlagValue(command, flag);
    if (value !== null) return value;
  }
  return null;
}

function splitQueryList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const query of queries) {
    const trimmed = query.trim();
    const key = normalizeIntegrationLookup(trimmed);
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

const COMPONENT_ACTION_START_SEGMENTS = new Set([
  "accept",
  "add",
  "append",
  "archive",
  "assign",
  "cancel",
  "close",
  "complete",
  "copy",
  "create",
  "custom",
  "delete",
  "download",
  "execute",
  "export",
  "fetch",
  "find",
  "forward",
  "generate",
  "get",
  "import",
  "insert",
  "invite",
  "list",
  "lookup",
  "make",
  "move",
  "open",
  "post",
  "publish",
  "quick",
  "reject",
  "remove",
  "reply",
  "run",
  "schedule",
  "search",
  "send",
  "set",
  "share",
  "submit",
  "sync",
  "trigger",
  "unarchive",
  "update",
  "upload",
  "upsert",
]);

function appFromComponentKey(componentKey: string | null): string[] {
  const value = componentKey?.trim();
  if (!value) return [];
  const parts = value
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  const actionIndex = parts.findIndex((part, index) => index > 0 && COMPONENT_ACTION_START_SEGMENTS.has(part));
  const app = (actionIndex > 0 ? parts.slice(0, actionIndex).join("-") : parts[0])?.trim();
  return app ? [app] : [];
}

function firstStringValue(record: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseRawJson(command: string): unknown {
  const value = shellFlagValue(command, "--raw");
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rawStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function stringListValue(value: unknown): string[] {
  if (typeof value === "string") return splitQueryList(value);
  return rawStringArray(value);
}

function rawQueryApps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const app = (item as Record<string, unknown>).app;
    return typeof app === "string" && app.trim() ? [app.trim()] : [];
  });
}

export function extractCanvasIntegrationLookups(command: string): {
  queries: string[];
  listConnected: boolean;
} {
  if (!/\$\{?CANVAS_CLI\}?/.test(command)) return { queries: [], listConnected: false };
  const raw = parseRawJson(command) as Record<string, unknown> | null;

  if (/\bsearch-apps\b/.test(command) || /\bsearch_apps\b/.test(command)) {
    const rawQueries = rawStringArray(raw?.queries);
    const queries = rawQueries.length > 0 ? rawQueries : splitQueryList(shellFlagValue(command, "--queries"));
    return { queries, listConnected: queries.length === 0 };
  }

  if (/\bget-components\b/.test(command) || /\bget_components\b/.test(command)) {
    const rawApps = rawStringArray(raw?.apps);
    const queries = rawApps.length > 0 ? rawApps : splitQueryList(shellFlagValue(command, "--apps"));
    return { queries, listConnected: false };
  }

  if (/\bsearch-components\b/.test(command) || /\bsearch_components\b/.test(command)) {
    return { queries: rawQueryApps(raw?.queries), listConnected: false };
  }

  if (/\bget-component-definition\b/.test(command) || /\bget_component_definition\b/.test(command)) {
    const componentKey =
      typeof raw?.key === "string"
        ? raw.key
        : shellFlagValueAny(command, ["--key", "--component-key", "--componentKey"]);
    return { queries: appFromComponentKey(componentKey), listConnected: false };
  }

  if (/\bdirect-execute-action\b/.test(command) || /\bdirect_execute_action\b/.test(command)) {
    const componentKey =
      typeof raw?.componentKey === "string"
        ? raw.componentKey
        : shellFlagValueAny(command, ["--component-key", "--componentKey"]);
    return { queries: appFromComponentKey(componentKey), listConnected: false };
  }

  if (/\bfetch-remote-options\b/.test(command) || /\bfetch_remote_options\b/.test(command)) {
    const componentKey =
      typeof raw?.componentKey === "string"
        ? raw.componentKey
        : shellFlagValueAny(command, ["--component-key", "--componentKey"]);
    return { queries: appFromComponentKey(componentKey), listConnected: false };
  }

  if (/\bcreate-sketch-trigger-workflow\b/.test(command) || /\bcreate_sketch_trigger_workflow\b/.test(command)) {
    const rawSlug = raw?.triggerAppSlug;
    const triggerAppSlug =
      typeof rawSlug === "string" ? rawSlug : shellFlagValueAny(command, ["--trigger-app-slug", "--triggerAppSlug"]);
    if (triggerAppSlug) return { queries: [triggerAppSlug], listConnected: false };
    const triggerComponentKey =
      typeof raw?.triggerComponentKey === "string"
        ? raw.triggerComponentKey
        : shellFlagValueAny(command, ["--trigger-component-key", "--triggerComponentKey"]);
    return { queries: appFromComponentKey(triggerComponentKey), listConnected: false };
  }

  return { queries: [], listConnected: false };
}

function extractMcpIntegrationLookups(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): {
  queries: string[];
  listConnected: boolean;
} {
  const match = toolName?.match(/^mcp__(.+?)__(.+)$/);
  const normalizedToolName = (match?.[2] ?? toolName ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

  if (normalizedToolName === "search-apps") {
    const queries = stringListValue(input?.queries);
    return { queries, listConnected: queries.length === 0 };
  }

  if (normalizedToolName === "get-components") {
    return { queries: stringListValue(input?.apps), listConnected: false };
  }

  if (normalizedToolName === "search-components") {
    return { queries: rawQueryApps(input?.queries), listConnected: false };
  }

  if (normalizedToolName === "get-component-definition") {
    const componentKey = firstStringValue(input, ["key", "componentKey"]);
    return { queries: appFromComponentKey(componentKey), listConnected: false };
  }

  if (normalizedToolName === "direct-execute-action" || normalizedToolName === "fetch-remote-options") {
    const componentKey = firstStringValue(input, ["componentKey", "key"]);
    return { queries: appFromComponentKey(componentKey), listConnected: false };
  }

  if (normalizedToolName === "create-sketch-trigger-workflow") {
    const triggerAppSlug = typeof input?.triggerAppSlug === "string" ? input.triggerAppSlug : null;
    if (triggerAppSlug) return { queries: [triggerAppSlug], listConnected: false };
    const triggerComponentKey = typeof input?.triggerComponentKey === "string" ? input.triggerComponentKey : null;
    return { queries: appFromComponentKey(triggerComponentKey), listConnected: false };
  }

  return { queries: [], listConnected: false };
}

const TOOL_RESULT_TEXT_LIMIT = 30_000;

function toolResultText(value: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  let remaining = TOOL_RESULT_TEXT_LIMIT;

  const append = (text: string) => {
    if (remaining <= 0 || !text) return;
    const chunk = text.slice(0, remaining);
    parts.push(chunk);
    remaining -= chunk.length;
  };

  const visit = (item: unknown, depth: number) => {
    if (remaining <= 0 || item === null || item === undefined || depth > 6) return;
    if (typeof item === "string") {
      append(item);
      return;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      append(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, depth + 1);
      }
      return;
    }
    if (typeof item !== "object") return;
    if (seen.has(item)) return;
    seen.add(item);

    const record = item as Record<string, unknown>;
    const entries = Object.entries(record);
    const priorityKeys = new Set(["text", "message", "error", "code", "connectionStatus", "status", "content", "data"]);
    const orderedEntries = [
      ...entries.filter(([key]) => priorityKeys.has(key)),
      ...entries.filter(([key]) => !priorityKeys.has(key)),
    ];

    for (const [key, child] of orderedEntries) {
      if (remaining <= 0) return;
      if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
        append(`${key}: ${String(child)}`);
        continue;
      }
      visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return parts.join("\n");
}

function toolResultIndicatesConnectionIssue(output: unknown): boolean {
  const text = toolResultText(output);
  if (!text.trim()) return false;
  return (
    /\bCONNECTION_NOT_CONNECTED\b/i.test(text) ||
    /\bconnectionStatus\b[^a-z0-9]+not[_\s-]?connected\b/i.test(text) ||
    (/\bnot[_\s-]?connected\b/i.test(text) &&
      /\b(app|account|auth|authorization|connect|connection|integration)\b/i.test(text)) ||
    (/\b(expired|revoked|invalid)\b/i.test(text) &&
      /\b(auth|authorization|token|credential|connect|connection|account)\b/i.test(text)) ||
    (/\b(401|403)\b/i.test(text) && /\b(auth|authorization|forbidden|unauthorized|credential|permission)\b/i.test(text))
  );
}

function normalizedMcpToolParts(toolName: string | undefined): { server: string | null; operation: string } {
  const match = toolName?.match(/^mcp__(.+?)__(.+)$/);
  const normalize = (value: string | undefined) =>
    (value ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/_/g, "-")
      .toLowerCase();
  return {
    server: match?.[1] ? normalize(match[1]) : null,
    operation: normalize(match?.[2] ?? toolName),
  };
}

function genericFailureQueries(toolName: string | undefined, input: Record<string, unknown> | undefined): string[] {
  const queries: string[] = [];
  const directApp = firstStringValue(input, ["app", "appSlug", "appId", "nameSlug", "triggerAppSlug"]);
  if (directApp) queries.push(directApp);
  const componentKey = firstStringValue(input, ["componentKey", "key", "triggerComponentKey"]);
  queries.push(...appFromComponentKey(componentKey));

  const { server, operation } = normalizedMcpToolParts(toolName);
  if (server && !["canvas", "sketch", "plugin-pipedream", "pipedream"].includes(server)) {
    queries.push(server);
  }
  if (server?.includes("pipedream")) {
    queries.push(...appFromComponentKey(operation));
  }

  return uniqueQueries(queries);
}

export function extractIntegrationLookupsFromProgressEvent(event: IntegrationProgressEventLike): {
  queries: string[];
  listConnected: boolean;
} {
  if (event.kind === "tool_result" && !toolResultIndicatesConnectionIssue(event.output)) {
    return { queries: [], listConnected: false };
  }
  if (event.kind !== "tool_use" && event.kind !== "tool_result") return { queries: [], listConnected: false };

  let lookup: { queries: string[]; listConnected: boolean };
  if (event.toolName === "Bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    lookup = extractCanvasIntegrationLookups(command);
  } else {
    lookup = extractMcpIntegrationLookups(event.toolName, event.input);
  }

  if (event.kind === "tool_result") {
    return {
      queries: uniqueQueries([...lookup.queries, ...genericFailureQueries(event.toolName, event.input)]),
      listConnected: false,
    };
  }

  return lookup;
}

export async function collectIntegrationCardsFromProgressEvents(params: {
  events: IntegrationProgressEventLike[];
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  collector?: IntegrationCardCollector;
  userEmail?: string | null;
  userName?: string | null;
}): Promise<void> {
  if (!params.loadIntegrationProvider || !params.collector || !params.userEmail) return;

  const queries = new Set<string>();
  let listConnected = false;
  for (const event of params.events) {
    const lookup = extractIntegrationLookupsFromProgressEvent(event);
    for (const query of lookup.queries) queries.add(query);
    listConnected ||= lookup.listConnected;
  }

  if (queries.size === 0 && !listConnected) return;

  const provider = await params.loadIntegrationProvider();
  if (!provider) return;

  const userEmail = params.userEmail;
  const connections = await provider.listConnections(userEmail, params.userName ?? undefined);
  const cards: WebChatIntegrationConnectionData[] = [];
  if (listConnected) cards.push(...connectedIntegrationCards(connections));
  for (const query of queries) {
    const result = await resolveIntegrationLookup(provider, connections, { query });
    cards.push(...result.cards.filter((card) => (card.state ?? "connect") === "connect"));
  }
  for (const card of dedupeIntegrationCards(cards)) {
    params.collector.collect(card);
  }
}

export async function connectedAccountCardsForUser(params: {
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  userEmail?: string | null;
  userName?: string | null;
  limit?: number;
}): Promise<WebChatIntegrationConnectionData[]> {
  if (!params.loadIntegrationProvider || !params.userEmail) return [];
  const provider = await params.loadIntegrationProvider();
  if (!provider) return [];
  const connections = await provider.listConnections(params.userEmail, params.userName ?? undefined);
  return connectedIntegrationCards(connections, params.limit);
}
