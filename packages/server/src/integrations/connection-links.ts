import type { WebChatIntegrationConnectionData } from "@sketch/shared";
import { dedupeIntegrationCards } from "./cards";

export type IntegrationConnectionLinkPlatform = "slack" | "whatsapp";

export interface IntegrationConnectionLinkConfig {
  BASE_URL?: string;
  PORT: number;
}

const INTEGRATION_APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function configuredBaseUrl(config: IntegrationConnectionLinkConfig): string | null {
  const configured = config.BASE_URL?.trim().replace(/\/+$/, "");
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "http:" || url.protocol === "https:" ? configured : null;
  } catch {
    return null;
  }
}

function baseUrl(config: IntegrationConnectionLinkConfig): string {
  return configuredBaseUrl(config) ?? `http://localhost:${config.PORT}`;
}

function safeSlackLabel(value: string): string {
  return value.replace(/[<>|]/g, "").replace(/&/g, "and").trim() || "this app";
}

function missingConnectionCards(
  cards: WebChatIntegrationConnectionData[] | undefined,
): WebChatIntegrationConnectionData[] {
  return dedupeIntegrationCards((cards ?? []).filter((card) => (card.state ?? "connect") === "connect"));
}

function hasConfiguredBaseUrl(config: IntegrationConnectionLinkConfig): boolean {
  return configuredBaseUrl(config) !== null;
}

function fallbackConnectionInstructions(
  cards: WebChatIntegrationConnectionData[],
  platform: IntegrationConnectionLinkPlatform,
): string | null {
  if (cards.length === 0) return null;
  const appNames = cards.map((card) => (platform === "slack" ? safeSlackLabel(card.appName) : card.appName));
  if (cards.length === 1) {
    return `To continue, open Integrations in Sketch to connect ${appNames[0]}.`;
  }
  return `To continue, open Integrations in Sketch to connect these apps: ${appNames.join(", ")}.`;
}

function cardAppNames(cards: WebChatIntegrationConnectionData[]): string[] {
  return cards.map((card) => card.appName.trim()).filter(Boolean);
}

function lineMentionsAnyApp(line: string, appNames: string[]): boolean {
  const normalized = line.toLowerCase();
  return appNames.some((appName) => normalized.includes(appName.toLowerCase()));
}

function isManualConnectionInstructionLine(line: string, appNames: string[]): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) return false;
  if (/settings\s*(->|→)\s*integrations/.test(normalized)) return true;
  if (/\bintegrations\?connect=/.test(normalized)) return true;
  if (/\b(api key|oauth flow|connection card|connect button|setup card|setup link)\b/.test(normalized)) return true;
  if (/\b(you'?ll|you will)\s+need\s+to\s+connect\b/.test(normalized)) return true;
  if (/\bonce\s+(they'?re|they are|those are|these are|it'?s|it is|connected)\b/.test(normalized)) return true;
  if (/^[-*]\s+/.test(normalized) && lineMentionsAnyApp(line, appNames) && /\b(connect|link|authorize)\b/i.test(line)) {
    return true;
  }
  return false;
}

function compactConnectionTextLines(lines: string[]): string {
  const compacted: string[] = [];
  for (const line of lines) {
    if (!line.trim() && compacted.at(-1) === "") continue;
    compacted.push(line.trimEnd());
  }
  return compacted.join("\n").trim();
}

export function sanitizeIntegrationConnectionText(
  text: string | null | undefined,
  cards: WebChatIntegrationConnectionData[] | undefined,
): string | null {
  const trimmedText = text?.trim() ?? "";
  const missingCards = missingConnectionCards(cards);
  if (!trimmedText || missingCards.length === 0) return trimmedText || null;

  const appNames = cardAppNames(missingCards);
  const lines = trimmedText.split(/\r?\n/).filter((line) => !isManualConnectionInstructionLine(line, appNames));
  const sanitized = compactConnectionTextLines(lines);
  if (sanitized) return sanitized;

  if (appNames.length === 1) return `${appNames[0]} needs to be connected before I can continue.`;
  const last = appNames.at(-1);
  const prefix = appNames.slice(0, -1).join(", ");
  return `${prefix} and ${last} need to be connected before I can continue.`;
}

export function integrationConnectionUrl(
  card: WebChatIntegrationConnectionData,
  config: IntegrationConnectionLinkConfig,
): string | null {
  if (!INTEGRATION_APP_ID_RE.test(card.appId)) return null;
  const url = new URL("/integrations", `${baseUrl(config)}/`);
  url.searchParams.set("connect", card.appId);
  return url.toString();
}

export function integrationConnectionCallbackUrl(config: IntegrationConnectionLinkConfig): string {
  return new URL("/integrations/callback", `${baseUrl(config)}/`).toString();
}

export function formatIntegrationConnectionLinks(
  cards: WebChatIntegrationConnectionData[] | undefined,
  platform: IntegrationConnectionLinkPlatform,
  config: IntegrationConnectionLinkConfig,
): string | null {
  const missingCards = missingConnectionCards(cards);
  if (!hasConfiguredBaseUrl(config)) return fallbackConnectionInstructions(missingCards, platform);

  const rows = missingCards
    .map((card) => ({ card, url: integrationConnectionUrl(card, config) }))
    .filter((row): row is { card: WebChatIntegrationConnectionData; url: string } => row.url !== null);
  if (rows.length === 0) return null;

  if (platform === "slack") {
    if (rows.length === 1) {
      const appName = safeSlackLabel(rows[0].card.appName);
      return `To continue: <${rows[0].url}|Connect ${appName}>`;
    }
    return [
      "Connect these apps to continue:",
      ...rows.map((row) => {
        const appName = safeSlackLabel(row.card.appName);
        return `- ${appName}: <${row.url}|Connect ${appName}>`;
      }),
    ].join("\n");
  }

  if (rows.length === 1) {
    return `To continue, connect ${rows[0].card.appName}: ${rows[0].url}`;
  }
  return ["Connect these apps to continue:", ...rows.map((row) => `- ${row.card.appName}: ${row.url}`)].join("\n");
}

export function appendIntegrationConnectionLinks(
  text: string | null | undefined,
  cards: WebChatIntegrationConnectionData[] | undefined,
  platform: IntegrationConnectionLinkPlatform,
  config: IntegrationConnectionLinkConfig,
): string | null {
  const trimmedText = sanitizeIntegrationConnectionText(text, cards)?.trim() ?? "";
  const links = formatIntegrationConnectionLinks(cards, platform, config);
  if (!links) return trimmedText || null;
  if (!trimmedText) return links;
  return `${trimmedText}\n\n${links}`;
}
