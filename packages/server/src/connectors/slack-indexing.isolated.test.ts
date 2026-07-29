import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import type { SlackIndexingFacade } from "../slack/indexing-facade";
import { createTestLogger } from "../test-utils";
import { createSlackIndexingConnector } from "./slack-indexing";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  chunkSlackConversations: vi.fn(),
  reconcileSlackChannelAcls: vi.fn(),
}));

vi.mock("./slack-chunker", () => ({
  chunkSlackConversations: mocks.chunkSlackConversations,
}));

vi.mock("./slack-salience", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slack-salience")>();
  return {
    ...actual,
    reconcileSlackChannelAcls: mocks.reconcileSlackChannelAcls,
  };
});

describe("Slack indexing connector ACL ordering", () => {
  it("refreshes raw-history membership before indexing work can fail", async () => {
    mocks.calls.length = 0;
    mocks.reconcileSlackChannelAcls.mockImplementation(async () => {
      mocks.calls.push("acl");
      return { scopesRefreshed: 1, scopesArchived: 0, filesArchived: 0 };
    });
    mocks.chunkSlackConversations.mockImplementation(async () => {
      mocks.calls.push("chunk");
      throw new Error("indexing interrupted");
    });

    const facade = {
      isConfigured: vi.fn().mockResolvedValue(true),
    } as unknown as SlackIndexingFacade;
    const sync = createSlackIndexingConnector().sync({
      db: {} as Kysely<DB>,
      connectorConfigId: "slack-config",
      credentials: { type: "system" },
      scopeConfig: {},
      cursor: null,
      logger: createTestLogger(),
      slackIndexing: facade,
    });

    await expect(sync.next()).rejects.toThrow("indexing interrupted");
    expect(mocks.calls).toEqual(["acl", "chunk"]);
  });
});
