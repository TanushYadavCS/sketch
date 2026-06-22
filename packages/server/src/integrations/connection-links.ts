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

function hasConfiguredBaseUrl(config: IntegrationConnectionLinkConfig): boolean {
  return Boolean(config.BASE_URL?.trim());
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
  const trimmedText = text?.trim() ?? "";
  const links = formatIntegrationConnectionLinks(cards, platform, config);
  if (!links) return trimmedText || null;
  if (!trimmedText) return links;
  return `${trimmedText}\n\n${links}`;
}
