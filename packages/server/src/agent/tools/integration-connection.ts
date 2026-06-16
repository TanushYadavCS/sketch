import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { connectedIntegrationCards, dedupeIntegrationCards, resolveIntegrationLookup } from "../../integrations/cards";
import type { SketchMcpDeps } from "./types";

export function createSearchIntegrationAppsTool(
  deps: Pick<
    SketchMcpDeps,
    "loadIntegrationProvider" | "integrationConnectionCollector" | "currentUserEmail" | "currentUserName"
  >,
) {
  return tool(
    "SearchIntegrationApps",
    "Search the configured integration provider catalog and return canonical app IDs plus connected status. Omit query when the user asks which integration accounts are already connected.",
    {
      query: z
        .string()
        .max(120)
        .optional()
        .describe("Product or app name to search, for example LinkedIn or Zoho CRM. Omit to list connected accounts."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum apps or connected accounts to return"),
    },
    async ({ query, limit }) => {
      if (!deps.loadIntegrationProvider) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: "No integration provider is configured." }),
            },
          ],
        };
      }

      const provider = await deps.loadIntegrationProvider();
      if (!provider) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: "No integration provider is configured." }),
            },
          ],
        };
      }

      if (!deps.currentUserEmail) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: "The current user does not have an email address." }),
            },
          ],
        };
      }

      const maxApps = Math.min(limit ?? 5, 20);
      const connections = await provider.listConnections(deps.currentUserEmail, deps.currentUserName ?? undefined);
      const trimmedQuery = query?.trim() ?? "";

      if (!trimmedQuery) {
        const cards = connectedIntegrationCards(connections, maxApps);
        for (const card of cards) deps.integrationConnectionCollector?.collect(card);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                connected_accounts: cards.map((card) => ({
                  app_id: card.appId,
                  app_name: card.appName,
                  state: "connected",
                  ...(card.icon ? { icon: card.icon } : {}),
                  ...(card.accountName ? { account_name: card.accountName } : {}),
                  connection_id: card.connectionId ?? null,
                })),
                instruction:
                  "Connected account cards have been rendered from provider state. Answer using this data without mentioning the UI mechanics.",
              }),
            },
          ],
        };
      }

      const result = await resolveIntegrationLookup(provider, connections, { query: trimmedQuery }, maxApps);
      const cardsToRender = dedupeIntegrationCards(result.cards).filter(
        (card) => (card.state ?? "connect") === "connect",
      );
      for (const card of cardsToRender) deps.integrationConnectionCollector?.collect(card);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              apps: result.apps.map((app) => ({
                app_id: app.id,
                app_name: app.name,
                connected: app.connected,
                connection_status: app.connectionStatus ?? (app.connected ? "active" : "not_connected"),
                connection_id: app.connectionId ?? null,
                ...(app.icon ? { icon: app.icon } : {}),
                ...(app.description ? { description: app.description } : {}),
                ...(app.accountName ? { account_name: app.accountName } : {}),
              })),
              instruction:
                cardsToRender.length > 0
                  ? "A connect card has been rendered because provider state identified one missing app account. Do not ask whether to show or open a card."
                  : "If the app identity is ambiguous, ask one concise clarification for the product/app name.",
            }),
          },
        ],
      };
    },
  );
}
