import { randomUUID } from "node:crypto";
import {
  type CliIntegrationCatalogApp,
  type CliIntegrationConnection,
  isCanvasBlockedCliAppId,
  isCanvasBlockedCliComponentKey,
} from "@sketch/shared";
import type { WebChatIntegrationConnectionData } from "@sketch/shared";
import type { IntegrationApp, IntegrationConnection, IntegrationProvider } from "./types";

export interface IntegrationCardCollector {
  collect(card: WebChatIntegrationConnectionData): void;
}

export interface IntegrationLookup {
  query: string;
  reason?: string;
}

export interface CliIntegrationCardResolver {
  listCatalog(query?: string): CliIntegrationCatalogApp[];
  listConnections(
    viewerUserId: string,
    context?: { platform?: "slack" | "whatsapp"; deliveryTarget?: string },
  ): Promise<CliIntegrationConnection[]>;
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

export interface ExtractedIntegrationLookups {
  queries: string[];
  componentKeys: string[];
  listConnected: boolean;
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

function normalizeExactIntegrationSlug(value: string | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null;
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
    providerId: connection.providerId,
    ...(connection.executionMode ? { executionMode: connection.executionMode } : {}),
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
  providerId?: string,
): WebChatIntegrationConnectionData {
  const executionMode = app.executionMode ?? connection?.executionMode;
  if (connection) {
    return {
      requestId: cardId("integration-connected", app.id),
      appId: app.id,
      appName: app.name,
      providerId: connection.providerId ?? providerId,
      ...(executionMode ? { executionMode } : {}),
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
    ...(providerId ? { providerId } : {}),
    ...(executionMode ? { executionMode } : {}),
    state: "connect",
    ...(app.icon ? { icon: app.icon } : {}),
    ...(executionMode === "canvas" || executionMode === "cli" || executionMode === "api"
      ? { connectUrl: `/integrations?connect=${encodeURIComponent(app.id)}` }
      : {}),
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  };
}

export function dedupeIntegrationCards(cards: WebChatIntegrationConnectionData[]): WebChatIntegrationConnectionData[] {
  const seen = new Set<string>();
  const deduped: WebChatIntegrationConnectionData[] = [];
  for (const card of cards) {
    const appKey = normalizeExactIntegrationSlug(card.appId) ?? normalizeIntegrationLookup(card.appId);
    const key = `${card.state ?? "connect"}:${card.providerId ?? ""}:${appKey}`;
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
  const safeApps =
    provider.type === "canvas"
      ? result.apps.filter((app) => !isCanvasBlockedCliAppId(app.id) && !isCanvasBlockedCliAppId(app.name))
      : result.apps;
  const apps = safeApps.map((app) => {
    const connection = connectionForApp(connections, app);
    return {
      ...app,
      connected: Boolean(connection),
      ...(connection?.status ? { connectionStatus: connection.status } : {}),
      connectionId: connection?.id ?? null,
      ...(connection?.accountName ? { accountName: connection.accountName } : {}),
    };
  });
  const cards = bestRenderableApps(safeApps, lookup.query).map((app) =>
    cardFromApp(app, connectionForApp(connections, app), lookup.reason, provider.providerId),
  );
  return { apps, cards };
}

export function connectedIntegrationCards(
  connections: IntegrationConnection[],
  limit = 20,
): WebChatIntegrationConnectionData[] {
  return connections
    .filter((connection) => !isCanvasBlockedCliAppId(connection.appId) && !isCanvasBlockedCliAppId(connection.appName))
    .filter(isActiveIntegrationConnection)
    .slice(0, limit)
    .map(connectedCardFromConnection);
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

function uniqueComponentKeys(componentKeys: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const componentKey of componentKeys) {
    const normalized = normalizeExactIntegrationSlug(componentKey);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function componentKeysFromValue(componentKey: string | null): string[] {
  const normalized = normalizeExactIntegrationSlug(componentKey ?? undefined);
  return normalized ? [normalized] : [];
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

export function extractCanvasIntegrationLookups(command: string): ExtractedIntegrationLookups {
  if (!/\$\{?CANVAS_CLI\}?/.test(command)) return { queries: [], componentKeys: [], listConnected: false };
  const raw = parseRawJson(command) as Record<string, unknown> | null;

  if (/\bsearch-apps\b/.test(command) || /\bsearch_apps\b/.test(command)) {
    const rawQueries = rawStringArray(raw?.queries);
    const queries = rawQueries.length > 0 ? rawQueries : splitQueryList(shellFlagValue(command, "--queries"));
    return { queries, componentKeys: [], listConnected: queries.length === 0 };
  }

  if (/\bget-components\b/.test(command) || /\bget_components\b/.test(command)) {
    const rawApps = rawStringArray(raw?.apps);
    const queries = rawApps.length > 0 ? rawApps : splitQueryList(shellFlagValue(command, "--apps"));
    return { queries, componentKeys: [], listConnected: false };
  }

  if (/\bsearch-components\b/.test(command) || /\bsearch_components\b/.test(command)) {
    return { queries: rawQueryApps(raw?.queries), componentKeys: [], listConnected: false };
  }

  if (/\bget-component-definition\b/.test(command) || /\bget_component_definition\b/.test(command)) {
    const componentKey =
      typeof raw?.key === "string"
        ? raw.key
        : shellFlagValueAny(command, ["--key", "--component-key", "--componentKey"]);
    return { queries: [], componentKeys: componentKeysFromValue(componentKey), listConnected: false };
  }

  if (/\bdirect-execute-action\b/.test(command) || /\bdirect_execute_action\b/.test(command)) {
    const componentKey =
      typeof raw?.componentKey === "string"
        ? raw.componentKey
        : shellFlagValueAny(command, ["--component-key", "--componentKey"]);
    return { queries: [], componentKeys: componentKeysFromValue(componentKey), listConnected: false };
  }

  if (/\bfetch-remote-options\b/.test(command) || /\bfetch_remote_options\b/.test(command)) {
    const componentKey =
      typeof raw?.componentKey === "string"
        ? raw.componentKey
        : shellFlagValueAny(command, ["--component-key", "--componentKey"]);
    return { queries: [], componentKeys: componentKeysFromValue(componentKey), listConnected: false };
  }

  if (/\bcreate-sketch-trigger-workflow\b/.test(command) || /\bcreate_sketch_trigger_workflow\b/.test(command)) {
    const rawSlug = raw?.triggerAppSlug;
    const triggerAppSlug =
      typeof rawSlug === "string" ? rawSlug : shellFlagValueAny(command, ["--trigger-app-slug", "--triggerAppSlug"]);
    if (triggerAppSlug) return { queries: [triggerAppSlug], componentKeys: [], listConnected: false };
    const triggerComponentKey =
      typeof raw?.triggerComponentKey === "string"
        ? raw.triggerComponentKey
        : shellFlagValueAny(command, ["--trigger-component-key", "--triggerComponentKey"]);
    return { queries: [], componentKeys: componentKeysFromValue(triggerComponentKey), listConnected: false };
  }

  return { queries: [], componentKeys: [], listConnected: false };
}

function extractMcpIntegrationLookups(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): ExtractedIntegrationLookups {
  const match = toolName?.match(/^mcp__(.+?)__(.+)$/);
  const server = match?.[1]
    ?.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  if (match && server !== "canvas" && server !== "sketch") {
    return { queries: [], componentKeys: [], listConnected: false };
  }
  const normalizedToolName = (match?.[2] ?? toolName ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

  if (normalizedToolName === "search-apps") {
    const queries = stringListValue(input?.queries);
    return { queries, componentKeys: [], listConnected: queries.length === 0 };
  }

  if (normalizedToolName === "get-components") {
    return { queries: stringListValue(input?.apps), componentKeys: [], listConnected: false };
  }

  if (normalizedToolName === "search-components") {
    return { queries: rawQueryApps(input?.queries), componentKeys: [], listConnected: false };
  }

  if (normalizedToolName === "get-component-definition") {
    const componentKey = firstStringValue(input, ["key", "componentKey"]);
    return { queries: [], componentKeys: componentKeysFromValue(componentKey), listConnected: false };
  }

  if (normalizedToolName === "direct-execute-action" || normalizedToolName === "fetch-remote-options") {
    const componentKey = firstStringValue(input, ["componentKey", "key"]);
    return { queries: [], componentKeys: componentKeysFromValue(componentKey), listConnected: false };
  }

  if (normalizedToolName === "create-sketch-trigger-workflow") {
    const triggerAppSlug = typeof input?.triggerAppSlug === "string" ? input.triggerAppSlug : null;
    if (triggerAppSlug) return { queries: [triggerAppSlug], componentKeys: [], listConnected: false };
    const triggerComponentKey = typeof input?.triggerComponentKey === "string" ? input.triggerComponentKey : null;
    return { queries: [], componentKeys: componentKeysFromValue(triggerComponentKey), listConnected: false };
  }

  return { queries: [], componentKeys: [], listConnected: false };
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

/**
 * Projects a raw tool-result payload down to the bounded text the per-run
 * progress-event log actually needs. Runtimes call this AT PUSH TIME so the log
 * retains only this capped string (<= TOOL_RESULT_TEXT_LIMIT chars) instead of
 * the full, possibly multi-MB tool output that lived until run end.
 *
 * Behaviour is preserved because the sole consumer of a retained tool_result's
 * `output` is `toolResultIndicatesConnectionIssue`, which flattens it through
 * `toolResultText` anyway. `toolResultText` is idempotent on its own output
 * (re-projecting a <=30k string returns it unchanged), so the connection-issue
 * scan sees identical text whether it receives the raw payload or this
 * projection.
 */
export function projectToolResultForProgressLog(output: unknown): string {
  return toolResultText(output);
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

function genericFailureLookups(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): Pick<ExtractedIntegrationLookups, "queries" | "componentKeys"> {
  const queries: string[] = [];
  const componentKeys: string[] = [];
  const { server, operation } = normalizedMcpToolParts(toolName);
  if (server?.includes("pipedream")) {
    const directApp = firstStringValue(input, ["app", "appSlug", "appId", "nameSlug", "triggerAppSlug"]);
    if (directApp) queries.push(directApp);
    const componentKey = firstStringValue(input, ["componentKey", "key", "triggerComponentKey"]);
    componentKeys.push(...componentKeysFromValue(componentKey));
    componentKeys.push(...componentKeysFromValue(operation));
  }

  return {
    queries: uniqueQueries(queries),
    componentKeys: uniqueComponentKeys(componentKeys),
  };
}

export function extractIntegrationLookupsFromProgressEvent(
  event: IntegrationProgressEventLike,
): ExtractedIntegrationLookups {
  if (event.kind === "tool_result" && !toolResultIndicatesConnectionIssue(event.output)) {
    return { queries: [], componentKeys: [], listConnected: false };
  }
  if (event.kind !== "tool_use" && event.kind !== "tool_result") {
    return { queries: [], componentKeys: [], listConnected: false };
  }

  let lookup: ExtractedIntegrationLookups;
  if (event.toolName === "Skill") {
    lookup = {
      queries: [],
      componentKeys: [],
      listConnected: false,
    };
  } else if (event.toolName === "Bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    lookup = extractCanvasIntegrationLookups(command);
  } else {
    lookup = extractMcpIntegrationLookups(event.toolName, event.input);
  }

  if (event.kind === "tool_result") {
    const failureLookups = genericFailureLookups(event.toolName, event.input);
    return {
      queries: uniqueQueries([...lookup.queries, ...failureLookups.queries]),
      componentKeys: uniqueComponentKeys([...lookup.componentKeys, ...failureLookups.componentKeys]),
      listConnected: false,
    };
  }

  return lookup;
}

function componentKeyPrefixes(componentKey: string): string[] {
  const normalized = normalizeExactIntegrationSlug(componentKey);
  if (!normalized) return [];
  const parts = normalized.split("-");
  const prefixes: string[] = [];
  for (let length = parts.length - 1; length > 0; length -= 1) {
    prefixes.push(parts.slice(0, length).join("-"));
  }
  return prefixes;
}

function connectionMatchesCandidateSlug(connection: IntegrationConnection, candidate: string): boolean {
  const candidateKey = normalizeExactIntegrationSlug(candidate);
  if (!candidateKey) return false;
  return [connection.appId, connection.app?.nameSlug]
    .map(normalizeExactIntegrationSlug)
    .some((connectionKey) => connectionKey === candidateKey);
}

function appFromConnection(connection: IntegrationConnection): IntegrationApp {
  return {
    id: connection.appId,
    name: connection.appName || connection.app?.name || connection.appId,
    description: "",
    ...(connection.executionMode ? { executionMode: connection.executionMode } : {}),
    ...(connection.icon || connection.app?.imgSrc ? { icon: connection.icon ?? connection.app?.imgSrc } : {}),
  };
}

async function resolveComponentKeyCard(
  provider: IntegrationProvider,
  connections: IntegrationConnection[],
  componentKey: string,
  appCache: Map<string, Promise<IntegrationApp | null>>,
  loadAppCatalog: () => Promise<IntegrationApp[]>,
): Promise<WebChatIntegrationConnectionData | null> {
  if (provider.type === "canvas" && isCanvasBlockedCliComponentKey(componentKey)) return null;
  for (const candidate of componentKeyPrefixes(componentKey)) {
    if (provider.type === "canvas" && isCanvasBlockedCliAppId(candidate)) continue;
    const exactConnections = connections.filter((connection) => connectionMatchesCandidateSlug(connection, candidate));
    if (exactConnections.length > 0) {
      const healthyConnection = exactConnections.find(isActiveIntegrationConnection);
      return healthyConnection
        ? null
        : cardFromApp(appFromConnection(exactConnections[0]), null, undefined, provider.providerId);
    }

    const candidateKey = normalizeExactIntegrationSlug(candidate);
    if (!candidateKey) continue;
    let appRequest = appCache.get(candidateKey);
    if (!appRequest) {
      appRequest = provider
        .listApps(candidate, 5, undefined)
        .then((result) => result.apps.find((app) => normalizeExactIntegrationSlug(app.id) === candidateKey) ?? null);
      appCache.set(candidateKey, appRequest);
    }

    const queriedApp = await appRequest;
    const app =
      queriedApp ??
      (await loadAppCatalog()).find((catalogApp) => normalizeExactIntegrationSlug(catalogApp.id) === candidateKey);
    if (!app) continue;
    const healthyConnection = connections.find(
      (connection) => connectionMatchesCandidateSlug(connection, app.id) && isActiveIntegrationConnection(connection),
    );
    return healthyConnection ? null : cardFromApp(app, null, undefined, provider.providerId);
  }

  return null;
}

function cliConnectionCard(connection: CliIntegrationConnection): WebChatIntegrationConnectionData {
  return {
    requestId: cardId("integration-connected", connection.appId),
    appId: connection.appId,
    appName: connection.appName,
    executionMode: connection.executionMode,
    state: "connected",
    ...(connection.accountAvatarUrl ? { icon: connection.accountAvatarUrl } : {}),
    accountName: `@${connection.accountLogin}`,
    connectionId: connection.id,
  };
}

function cliCardForApp(
  app: CliIntegrationCatalogApp,
  connections: CliIntegrationConnection[],
): WebChatIntegrationConnectionData | null {
  const connection = connections.find(
    (item) => item.appId === app.id && item.status === "active" && item.canUse !== false,
  );
  if (connection) return null;
  return cardFromApp({ ...app, executionMode: app.executionMode }, null, `Connect ${app.name} in Sketch Integrations.`);
}

function cliAppForQuery(resolver: CliIntegrationCardResolver, query: string): CliIntegrationCatalogApp | null {
  const queryKey = normalizeIntegrationLookup(query);
  return (
    resolver.listCatalog().find((candidate) => {
      const candidateKeys = [candidate.id, candidate.name].map(normalizeIntegrationLookup);
      return candidateKeys.some((candidateKey) => candidateKey === queryKey);
    }) ?? null
  );
}

function cliCardForComponentKey(
  resolver: CliIntegrationCardResolver,
  connections: CliIntegrationConnection[],
  componentKey: string,
): WebChatIntegrationConnectionData | null {
  const componentKeyValue = normalizeIntegrationLookup(componentKey);
  const app = resolver
    .listCatalog()
    .filter((item) => componentKeyValue.startsWith(normalizeIntegrationLookup(item.id)))
    .sort((left, right) => normalizeIntegrationLookup(right.id).length - normalizeIntegrationLookup(left.id).length)[0];
  return app ? cliCardForApp(app, connections) : null;
}

export async function collectIntegrationCardsFromProgressEvents(params: {
  events: IntegrationProgressEventLike[];
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  cliIntegrations?: CliIntegrationCardResolver;
  currentUserId?: string | null;
  runtimeContext?: { platform?: "slack" | "whatsapp"; deliveryTarget?: string };
  collector?: IntegrationCardCollector;
  userEmail?: string | null;
  userName?: string | null;
}): Promise<void> {
  if (!params.collector) return;

  const queries = new Set<string>();
  const componentKeys = new Set<string>();
  let listConnected = false;
  for (const event of params.events) {
    const lookup = extractIntegrationLookupsFromProgressEvent(event);
    for (const query of lookup.queries) queries.add(query);
    for (const componentKey of uniqueComponentKeys(lookup.componentKeys)) componentKeys.add(componentKey);
    listConnected ||= lookup.listConnected;
  }

  if (queries.size === 0 && componentKeys.size === 0 && !listConnected) return;

  const cliConnections =
    params.cliIntegrations && params.currentUserId
      ? await params.cliIntegrations.listConnections(params.currentUserId, params.runtimeContext)
      : [];
  const cards: WebChatIntegrationConnectionData[] = [];
  const canvasQueries = new Set<string>();
  for (const query of queries) {
    const cliApp = params.cliIntegrations ? cliAppForQuery(params.cliIntegrations, query) : null;
    if (cliApp) {
      const card = cliCardForApp(cliApp, cliConnections);
      if (card) cards.push(card);
    } else {
      canvasQueries.add(query);
    }
  }
  const cliComponentKeys = new Set<string>();
  const canvasComponentKeys = new Set<string>();
  for (const componentKey of componentKeys) {
    if (
      params.cliIntegrations
        ?.listCatalog()
        .some((app) => normalizeIntegrationLookup(componentKey).startsWith(normalizeIntegrationLookup(app.id)))
    ) {
      cliComponentKeys.add(componentKey);
    } else {
      canvasComponentKeys.add(componentKey);
    }
  }

  const userEmail = params.userEmail;
  const needsCanvas =
    (listConnected || canvasQueries.size > 0 || canvasComponentKeys.size > 0) && Boolean(params.userEmail);
  const provider =
    needsCanvas && userEmail && params.loadIntegrationProvider ? await params.loadIntegrationProvider() : null;
  const connections =
    provider && userEmail ? await provider.listConnections(userEmail, params.userName ?? undefined) : [];

  if (listConnected) {
    cards.push(...connectedIntegrationCards(connections));
    cards.push(
      ...cliConnections
        .filter((connection) => connection.status === "active" && connection.canUse !== false)
        .map(cliConnectionCard),
    );
  }

  if (provider) {
    for (const query of canvasQueries) {
      const result = await resolveIntegrationLookup(provider, connections, { query });
      cards.push(...result.cards.filter((card) => (card.state ?? "connect") === "connect"));
    }
    const appCache = new Map<string, Promise<IntegrationApp | null>>();
    let appCatalogRequest: Promise<IntegrationApp[]> | null = null;
    const loadAppCatalog = () => {
      appCatalogRequest ??= provider.listApps(undefined, 20, undefined).then((result) => result.apps);
      return appCatalogRequest;
    };
    for (const componentKey of canvasComponentKeys) {
      const card = await resolveComponentKeyCard(provider, connections, componentKey, appCache, loadAppCatalog);
      if (card) cards.push(card);
    }
  }
  if (params.cliIntegrations) {
    for (const componentKey of cliComponentKeys) {
      const card = cliCardForComponentKey(params.cliIntegrations, cliConnections, componentKey);
      if (card) cards.push(card);
    }
  }

  for (const card of dedupeIntegrationCards(cards)) {
    params.collector.collect(card);
  }
}

export async function connectedAccountCardsForUser(params: {
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  cliIntegrations?: CliIntegrationCardResolver;
  currentUserId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  limit?: number;
}): Promise<WebChatIntegrationConnectionData[]> {
  const cards: WebChatIntegrationConnectionData[] = [];
  if (params.cliIntegrations && params.currentUserId) {
    const cliConnections = await params.cliIntegrations.listConnections(params.currentUserId);
    cards.push(
      ...cliConnections
        .filter((connection) => connection.status === "active" && connection.canUse !== false)
        .map(cliConnectionCard),
    );
  }
  if (params.loadIntegrationProvider && params.userEmail) {
    const provider = await params.loadIntegrationProvider();
    if (provider) {
      const connections = await provider.listConnections(params.userEmail, params.userName ?? undefined);
      cards.push(...connectedIntegrationCards(connections, params.limit));
    }
  }
  return dedupeIntegrationCards(cards).slice(0, params.limit ?? 20);
}
