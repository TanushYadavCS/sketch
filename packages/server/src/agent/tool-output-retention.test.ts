import { describe, expect, it } from "vitest";
import { type IntegrationProgressEventLike, collectIntegrationCardsFromProgressEvents } from "../integrations/cards";
import type { IntegrationProvider } from "../integrations/types";
import { applySdkStreamMessageMapping, createSdkStreamMappingState } from "./runner";
import { createAgentRuntimeCustomToolEffects } from "./runtime/custom-tools";

/**
 * P2 memory audit: the per-run integration progress-event log must retain only
 * the bounded text the card collector inspects, never the full multi-MB tool
 * output. `TOOL_RESULT_TEXT_LIMIT` in cards.ts caps that projection at 30k
 * chars, so any retained tool_result output must not exceed it.
 */
const RETAINED_OUTPUT_LIMIT = 30_000;
const HUGE_PAYLOAD = "x".repeat(2_000_000);
const CONNECTION_ISSUE_OUTPUT = `CONNECTION_NOT_CONNECTED ${HUGE_PAYLOAD}`;

function slackAppProvider(): IntegrationProvider {
  return {
    listConnections: async () => [],
    listApps: async () => ({
      apps: [{ id: "slack", name: "Slack", description: "Team chat", icon: "https://cdn.example/slack.png" }],
      pageInfo: { endCursor: null, hasMore: false },
    }),
  } as Pick<IntegrationProvider, "listApps" | "listConnections"> as IntegrationProvider;
}

async function collectCards(events: IntegrationProgressEventLike[]): Promise<unknown[]> {
  const cards: unknown[] = [];
  await collectIntegrationCardsFromProgressEvents({
    events,
    loadIntegrationProvider: async () => slackAppProvider(),
    userEmail: "alice@example.com",
    userName: "Alice",
    collector: { collect: (card) => cards.push(card) },
  });
  return cards;
}

function retainedToolResults(events: IntegrationProgressEventLike[]): IntegrationProgressEventLike[] {
  return events.filter((event) => event.kind === "tool_result");
}

/**
 * Cards carry a per-call random `requestId`, so raw equality across two
 * independent collection passes would always differ. Comparing the stable
 * identity fields proves the projected log yields the same cards as the raw
 * output would have.
 */
function stableCards(cards: unknown[]): unknown[] {
  return cards.map((card) => {
    const { requestId: _requestId, ...rest } = card as Record<string, unknown>;
    return rest;
  });
}

describe("SDK runtime tool-output retention", () => {
  it("bounds a multi-MB tool result in the retained progress log at push time", () => {
    const state = createSdkStreamMappingState();
    applySdkStreamMessageMapping(state, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "mcp__plugin_pipedream__action",
            input: { appSlug: "slack" },
          },
        ],
      },
    });
    applySdkStreamMessageMapping(state, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: CONNECTION_ISSUE_OUTPUT, is_error: true }],
      },
    });

    const [result] = retainedToolResults(state.integrationProgressEvents);
    expect(typeof result.output).toBe("string");
    expect((result.output as string).length).toBeLessThanOrEqual(RETAINED_OUTPUT_LIMIT);
    expect((result.output as string).length).toBeLessThan(HUGE_PAYLOAD.length);
  });

  it("produces the same cards as if the full raw output were retained", async () => {
    const state = createSdkStreamMappingState();
    for (const command of ["$CANVAS_CLI search-apps --queries=slack", "$CANVAS_CLI get-components --apps=slack"]) {
      applySdkStreamMessageMapping(state, {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `tool-${command.length}`, name: "Bash", input: { command } }] },
      });
      applySdkStreamMessageMapping(state, {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool-${command.length}`,
              content: CONNECTION_ISSUE_OUTPUT,
              is_error: true,
            },
          ],
        },
      });
    }

    const rawEquivalent: IntegrationProgressEventLike[] = state.integrationProgressEvents.map((event) =>
      event.kind === "tool_result" ? { ...event, output: CONNECTION_ISSUE_OUTPUT } : event,
    );

    const cardsFromRetained = await collectCards(state.integrationProgressEvents);
    const cardsFromRaw = await collectCards(rawEquivalent);

    expect(cardsFromRetained).toMatchObject([{ appId: "slack", state: "connect" }]);
    expect(stableCards(cardsFromRetained)).toEqual(stableCards(cardsFromRaw));
  });
});

describe("AI SDK runtime tool-output retention", () => {
  it("bounds a multi-MB tool result in the retained progress log at push time", () => {
    const effects = createAgentRuntimeCustomToolEffects();
    const input = { appSlug: "slack" };
    effects.onToolStart({ name: "mcp__plugin_pipedream__action", input });
    effects.onToolEnd({
      name: "mcp__plugin_pipedream__action",
      input,
      result: CONNECTION_ISSUE_OUTPUT,
      durationMs: 1,
    });

    const [result] = retainedToolResults(effects.integrationProgressEvents);
    expect(typeof result.output).toBe("string");
    expect((result.output as string).length).toBeLessThanOrEqual(RETAINED_OUTPUT_LIMIT);
    expect((result.output as string).length).toBeLessThan(HUGE_PAYLOAD.length);
  });

  it("produces the same cards as if the full raw output were retained", async () => {
    const effects = createAgentRuntimeCustomToolEffects();
    const input = { appSlug: "slack" };
    effects.onToolStart({ name: "mcp__plugin_pipedream__action", input });
    effects.onToolEnd({
      name: "mcp__plugin_pipedream__action",
      input,
      result: CONNECTION_ISSUE_OUTPUT,
      durationMs: 1,
    });

    const rawEquivalent: IntegrationProgressEventLike[] = effects.integrationProgressEvents.map((event) =>
      event.kind === "tool_result" ? { ...event, output: CONNECTION_ISSUE_OUTPUT } : event,
    );

    const cardsFromRetained = await collectCards(effects.integrationProgressEvents);
    const cardsFromRaw = await collectCards(rawEquivalent);

    expect(cardsFromRetained).toMatchObject([{ appId: "slack", state: "connect" }]);
    expect(stableCards(cardsFromRetained)).toEqual(stableCards(cardsFromRaw));
  });
});
