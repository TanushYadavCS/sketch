import type { Kysely } from "kysely";
import type { AgentOutputItemInput } from "../db/repositories/agent-outputs";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import type { IntegrationConnection, IntegrationStatus } from "../integrations/types";

export type ContextAuthorityReadStatus = "available" | "absent" | "unavailable";
export type ContextAuthorityAppSource = "connector" | "integration";

export interface ContextAuthorityApp {
  key: string;
  names: string[];
  aliases: string[];
  source: ContextAuthorityAppSource;
  updatedAt: string | null;
}

export interface ContextAuthoritySection {
  status: ContextAuthorityReadStatus;
  apps: ContextAuthorityApp[];
}

export interface ContextAuthoritySnapshot {
  capturedAt: string;
  connectors: ContextAuthoritySection;
  integrations: ContextAuthoritySection;
  connectedApps: ContextAuthorityApp[];
}

export interface BuildContextAuthorityInput {
  db: Kysely<DB>;
  userId: string;
  userEmail: string | null;
  userName: string;
  now: Date;
  getIntegrationStatus?: () => Promise<IntegrationStatus>;
}

export interface ContextAuthorityReconciliation {
  items: AgentOutputItemInput[];
  suppressedCount: number;
}

type ClaimMatch = {
  start: number;
  end: number;
  target: string;
};

const CORRECTION_PATTERNS = [
  /\b(?:incorrect|incorrectly|wrong|wrongly|stale|outdated)\b/iu,
  /\b(?:already|now)\s+(?:connected|authenticated|authorized|fixed|resolved)\b/iu,
  /\b(?:fixed|resolved|corrected)\b/iu,
  /\bno longer (?:true|needed|required|a problem|an issue)\b/iu,
];

const CONNECTION_CLAIM_PATTERNS = [
  /(.{1,120}?)\s+(?:is|are)\s+(?:not|no longer)\s+(?:connected|authenticated|authorized)\b/giu,
  /(.{1,120}?)\s+(?:isn['’]t|aren['’]t)\s+(?:connected|authenticated|authorized)\b/giu,
  /(.{1,120}?)\s+(?:is|are)\s+disconnected\b/giu,
  /\b(?:connect|reconnect|authenticate|reauthorize|authorize)\s+(?:to\s+)?(.{1,120}?)(?=\b(?:before|after|to|so that|because|for)\b|[.;!?]|$)/giu,
  /(.{1,120}?)\s+(?:needs?|requires?)\s+(?:authentication|authorization|reauthorization|reconnection)\b/giu,
  /(.{1,120}?)\s+(?:credentials?|tokens?|authorization|authentication)\s+(?:(?:are|is)\s+)?(?:missing|expired|invalid|required)\b/giu,
  /\b(?:authentication|authorization|reauthorization)\s+(?:is\s+)?required\s+(?:for|on)\s+(.{1,120}?)(?=[.;!?]|$)/giu,
];

const GENERIC_TARGETS = new Set([
  "app",
  "application",
  "account",
  "connection",
  "connector",
  "integration",
  "both",
  "both apps",
  "both applications",
  "both accounts",
  "both connections",
  "both connectors",
  "both integrations",
  "these apps",
  "these applications",
  "these accounts",
  "these connections",
  "these connectors",
  "these integrations",
  "the apps",
  "the applications",
  "the accounts",
  "the connections",
  "the connectors",
  "the integrations",
  "them",
  "it",
]);

const CONNECTION_CONTEXT_WORDS = new Set([
  "a",
  "account",
  "accounts",
  "app",
  "application",
  "applications",
  "apps",
  "authentication",
  "authorization",
  "authorized",
  "connected",
  "connection",
  "connections",
  "connector",
  "connectors",
  "credential",
  "credentials",
  "has",
  "integration",
  "integrations",
  "issue",
  "login",
  "remediation",
  "required",
  "status",
  "token",
  "tokens",
]);

const ALLOWED_RESIDUAL_WORDS = new Set([
  "a",
  "after",
  "again",
  "and",
  "are",
  "as",
  "at",
  "authentication",
  "authorization",
  "before",
  "because",
  "brief",
  "continue",
  "continuing",
  "data",
  "for",
  "from",
  "in",
  "is",
  "it",
  "needed",
  "of",
  "on",
  "or",
  "prepare",
  "preparing",
  "proceed",
  "proceeding",
  "required",
  "run",
  "so",
  "source",
  "sources",
  "summary",
  "sync",
  "syncing",
  "that",
  "the",
  "this",
  "to",
  "use",
  "using",
  "with",
]);

function normalizePhrase(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function aliasesForNames(names: string[]): string[] {
  const aliases: string[] = [];
  for (const name of names) {
    const normalized = normalizePhrase(name);
    if (!normalized) continue;
    const words = normalized.split(" ");
    for (let index = 0; index < words.length; index += 1) {
      const suffix = words.slice(index).join(" ");
      if (index === 0 || suffix.replaceAll(" ", "").length >= 5) {
        aliases.push(suffix, suffix.replaceAll(" ", ""));
      }
    }
  }
  return uniqueStrings(aliases);
}

function connectorApp(row: {
  connector_type: string;
  last_synced_at: string | null;
  updated_at: string;
}): ContextAuthorityApp {
  const name = row.connector_type.trim();
  return {
    key: `connector:${normalizePhrase(name).replaceAll(" ", "_")}`,
    names: [name],
    aliases: aliasesForNames([name]),
    source: "connector",
    updatedAt: row.last_synced_at ?? row.updated_at,
  };
}

function integrationNames(connection: IntegrationConnection): string[] {
  return uniqueStrings(
    [connection.appId, connection.appName, connection.app?.nameSlug, connection.app?.name]
      .map((value) => value?.trim() ?? "")
      .filter(Boolean),
  );
}

function integrationApp(connection: IntegrationConnection): ContextAuthorityApp {
  const names = integrationNames(connection);
  return {
    key: `integration:${normalizePhrase(connection.appId).replaceAll(" ", "-")}`,
    names,
    aliases: aliasesForNames(names),
    source: "integration",
    updatedAt: connection.connectedAt ?? connection.createdAt ?? null,
  };
}

async function loadConnectorAuthority(input: BuildContextAuthorityInput): Promise<ContextAuthoritySection> {
  try {
    const rows = await createConnectorRepository(input.db).listConnectedAuthorityStatesByOwner(input.userId);
    const apps = rows.map(connectorApp).sort((left, right) => left.key.localeCompare(right.key));
    return { status: apps.length > 0 ? "available" : "absent", apps };
  } catch {
    return { status: "unavailable", apps: [] };
  }
}

async function loadIntegrationAuthority(input: BuildContextAuthorityInput): Promise<ContextAuthoritySection> {
  if (!input.getIntegrationStatus) return { status: "absent", apps: [] };
  try {
    const status = await input.getIntegrationStatus();
    if (status.kind === "absent") return { status: "absent", apps: [] };
    if (status.kind === "load_failed" || !input.userEmail) return { status: "unavailable", apps: [] };
    const connections = await status.provider.listConnections(input.userEmail, input.userName);
    const apps = connections
      .filter(
        (connection) => connection.status === "active" && connection.healthy !== false && connection.canUse !== false,
      )
      .map(integrationApp)
      .sort((left, right) => left.key.localeCompare(right.key));
    return { status: "available", apps };
  } catch {
    return { status: "unavailable", apps: [] };
  }
}

export async function buildContextAuthoritySnapshot(
  input: BuildContextAuthorityInput,
): Promise<ContextAuthoritySnapshot> {
  const [connectors, integrations] = await Promise.all([
    loadConnectorAuthority(input),
    loadIntegrationAuthority(input),
  ]);
  return {
    capturedAt: input.now.toISOString(),
    connectors,
    integrations,
    connectedApps: [...connectors.apps, ...integrations.apps].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function isReadStatus(value: unknown): value is ContextAuthorityReadStatus {
  return value === "available" || value === "absent" || value === "unavailable";
}

function isAppSource(value: unknown): value is ContextAuthorityAppSource {
  return value === "connector" || value === "integration";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isAuthorityApp(value: unknown): value is ContextAuthorityApp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const app = value as Record<string, unknown>;
  return (
    typeof app.key === "string" &&
    isStringArray(app.names) &&
    isStringArray(app.aliases) &&
    isAppSource(app.source) &&
    (typeof app.updatedAt === "string" || app.updatedAt === null)
  );
}

function isAuthoritySection(value: unknown): value is ContextAuthoritySection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const section = value as Record<string, unknown>;
  return (
    isReadStatus(section.status) && Array.isArray(section.apps) && section.apps.every((app) => isAuthorityApp(app))
  );
}

export function readContextAuthoritySnapshot(value: unknown): ContextAuthoritySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.capturedAt !== "string") return null;
  if (!isAuthoritySection(snapshot.connectors) || !isAuthoritySection(snapshot.integrations)) return null;
  if (!Array.isArray(snapshot.connectedApps) || !snapshot.connectedApps.every(isAuthorityApp)) return null;
  return value as ContextAuthoritySnapshot;
}

function cleanTarget(value: string): string {
  return normalizePhrase(value)
    .replace(/^(?:a|an|the|my|our)\s+/u, "")
    .replace(/\s+(?:apps?|applications?|accounts?|integrations?|connections?|connectors?)$/u, "")
    .trim();
}

function targetFragments(value: string): string[] {
  return value
    .split(/\s*(?:,|&|\/|\band\b)\s*/iu)
    .map(cleanTarget)
    .filter(Boolean);
}

function findClaimMatches(text: string): ClaimMatch[] {
  const matches: ClaimMatch[] = [];
  for (const pattern of CONNECTION_CLAIM_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || !match[1]) continue;
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        target: match[1],
      });
    }
  }
  const selected: ClaimMatch[] = [];
  for (const match of matches.sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (selected.some((candidate) => match.start < candidate.end && match.end > candidate.start)) continue;
    selected.push(match);
  }
  return selected;
}

function residualText(text: string, matches: ClaimMatch[]): string {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of matches) {
    const previous = ranges.at(-1);
    if (!previous || match.start > previous.end) {
      ranges.push({ start: match.start, end: match.end });
    } else {
      previous.end = Math.max(previous.end, match.end);
    }
  }
  let cursor = 0;
  let residual = "";
  for (const range of ranges) {
    residual += ` ${text.slice(cursor, range.start)}`;
    cursor = range.end;
  }
  residual += ` ${text.slice(cursor)}`;
  return normalizePhrase(residual);
}

function isGenericConnectionContext(text: string): boolean {
  const tokens = normalizePhrase(text).split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.length <= 5 && tokens.every((token) => CONNECTION_CONTEXT_WORDS.has(token));
}

function containsTokenSequence(tokens: string[], sequence: string[]): number {
  if (sequence.length === 0 || sequence.length > tokens.length) return -1;
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) return index;
  }
  return -1;
}

function isKnownAppConnectionContext(text: string, snapshot: ContextAuthoritySnapshot): boolean {
  const tokens = normalizePhrase(text).split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 8) return false;
  return snapshot.connectedApps.some((app) =>
    app.aliases.some((alias) => {
      const aliasTokens = normalizePhrase(alias).split(" ").filter(Boolean);
      const aliasIndex = containsTokenSequence(tokens, aliasTokens);
      if (aliasIndex === -1) return false;
      const remaining = tokens.filter((_, index) => index < aliasIndex || index >= aliasIndex + aliasTokens.length);
      return remaining.length > 0 && remaining.every((token) => CONNECTION_CONTEXT_WORDS.has(token));
    }),
  );
}

function isConnectionOnlyText(text: string, matches: ClaimMatch[], snapshot: ContextAuthoritySnapshot): boolean {
  if (matches.length === 0) {
    return isGenericConnectionContext(text) || isKnownAppConnectionContext(text, snapshot);
  }
  const residualTokens = residualText(text, matches).split(" ").filter(Boolean);
  return residualTokens.every((token) => ALLOWED_RESIDUAL_WORDS.has(token));
}

function minimumConcreteTargetsForGeneric(target: string): number {
  if (target === "it") return 1;
  if (target === "both" || target === "them") return 2;
  return Number.POSITIVE_INFINITY;
}

function appMatchesTarget(app: ContextAuthorityApp, target: string): boolean {
  const normalized = cleanTarget(target);
  const compact = normalized.replaceAll(" ", "");
  return app.aliases.some((alias) => alias === normalized || alias === compact);
}

function isObsoleteConnectionClaim(
  item: Pick<AgentOutputItemInput, "title" | "summary" | "actionPrompt">,
  snapshot: ContextAuthoritySnapshot,
): boolean {
  if (snapshot.connectors.status === "unavailable" || snapshot.integrations.status === "unavailable") return false;
  if (snapshot.connectedApps.length === 0) return false;
  const texts = [item.title, item.summary, item.actionPrompt].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (texts.some((text) => CORRECTION_PATTERNS.some((pattern) => pattern.test(text)))) return false;
  const textMatches = texts.map((text) => ({ text, matches: findClaimMatches(text) }));
  if (textMatches.some(({ text, matches }) => !isConnectionOnlyText(text, matches, snapshot))) return false;
  const targets = textMatches.flatMap(({ matches }) => matches.flatMap((match) => targetFragments(match.target)));
  const normalizedTargets = uniqueStrings(targets);
  const genericTargets = normalizedTargets.filter((target) => GENERIC_TARGETS.has(target));
  const concreteTargets = normalizedTargets.filter((target) => !GENERIC_TARGETS.has(target));
  if (concreteTargets.length === 0) return false;
  if (genericTargets.some((target) => concreteTargets.length < minimumConcreteTargetsForGeneric(target))) {
    return false;
  }
  return concreteTargets.every((target) => snapshot.connectedApps.some((app) => appMatchesTarget(app, target)));
}

export function reconcileItemsWithContextAuthority(
  items: AgentOutputItemInput[],
  snapshot: ContextAuthoritySnapshot | null,
): ContextAuthorityReconciliation {
  if (!snapshot) return { items, suppressedCount: 0 };
  const retained: AgentOutputItemInput[] = [];
  let suppressedCount = 0;
  for (const item of items) {
    if (isObsoleteConnectionClaim(item, snapshot)) {
      suppressedCount += 1;
    } else {
      retained.push(item);
    }
  }
  return { items: retained, suppressedCount };
}
