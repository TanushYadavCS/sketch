import type { WebChatIntegrationConnectionData } from "@sketch/shared";
import { dedupeIntegrationCards } from "./cards";

export type IntegrationConnectionLinkPlatform = "slack" | "whatsapp";

export interface IntegrationConnectionLinkConfig {
  BASE_URL?: string;
  PORT: number;
}

const INTEGRATION_APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function baseUrl(config: IntegrationConnectionLinkConfig): string {
  const configured = config.BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `http://localhost:${config.PORT}`;
}

function safeSlackLabel(value: string): string {
  return value.replace(/[<>|]/g, "").replace(/&/g, "and").trim() || "this app";
}

function missingConnectionCards(
  cards: WebChatIntegrationConnectionData[] | undefined,
): WebChatIntegrationConnectionData[] {
  return dedupeIntegrationCards((cards ?? []).filter((card) => (card.state ?? "connect") === "connect"));
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

function safeConnectionUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function formatIntegrationConnectionLinks(
  cards: WebChatIntegrationConnectionData[] | undefined,
  platform: IntegrationConnectionLinkPlatform,
  config: IntegrationConnectionLinkConfig,
): string | null {
  const rows = missingConnectionCards(cards)
    .map((card) => ({ card, url: safeConnectionUrl(card.connectUrl) ?? integrationConnectionUrl(card, config) }))
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
  const trimmedText = text?.trim() ?? "";
  const links = formatIntegrationConnectionLinks(cards, platform, config);
  if (!links) return trimmedText || null;
  if (!trimmedText) return links;
  return `${trimmedText}\n\n${links}`;
}
