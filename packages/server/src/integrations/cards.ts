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
  const doubleQuoted = command.match(new RegExp(`${escaped}\\s+"([^"]+)"`));
  if (doubleQuoted?.[1]) return doubleQuoted[1];
  const singleQuoted = command.match(new RegExp(`${escaped}\\s+'([^']+)'`));
  if (singleQuoted?.[1]) return singleQuoted[1];
  const bare = command.match(new RegExp(`${escaped}\\s+([^\\s]+)`));
  return bare?.[1] ?? null;
}

function splitQueryList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function appFromComponentKey(componentKey: string | null): string[] {
  const value = componentKey?.trim();
  if (!value) return [];
  const app = value.split("-")[0]?.trim();
  return app ? [app] : [];
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

  if (/\bdirect-execute-action\b/.test(command) || /\bdirect_execute_action\b/.test(command)) {
    const componentKey =
      typeof raw?.componentKey === "string" ? raw.componentKey : shellFlagValue(command, "--component-key");
    return { queries: appFromComponentKey(componentKey), listConnected: false };
  }

  if (/\bfetch-remote-options\b/.test(command) || /\bfetch_remote_options\b/.test(command)) {
    const componentKey =
      typeof raw?.componentKey === "string" ? raw.componentKey : shellFlagValue(command, "--component-key");
    return { queries: appFromComponentKey(componentKey), listConnected: false };
  }

  if (/\bcreate-sketch-trigger-workflow\b/.test(command) || /\bcreate_sketch_trigger_workflow\b/.test(command)) {
    const rawSlug = raw?.triggerAppSlug;
    const triggerAppSlug = typeof rawSlug === "string" ? rawSlug : shellFlagValue(command, "--trigger-app-slug");
    return { queries: triggerAppSlug ? [triggerAppSlug] : [], listConnected: false };
  }

  return { queries: [], listConnected: false };
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
    if (event.kind !== "tool_use" || event.toolName !== "Bash") continue;
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const lookup = extractCanvasIntegrationLookups(command);
    for (const query of lookup.queries) queries.add(query);
    listConnected ||= lookup.listConnected;
  }

  if (queries.size === 0 && !listConnected) return;

  const provider = await params.loadIntegrationProvider();
  if (!provider) return;

  const connections = await provider.listConnections(params.userEmail, params.userName ?? undefined);
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
