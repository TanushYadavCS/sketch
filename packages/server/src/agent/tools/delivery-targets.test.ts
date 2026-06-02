import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChannelRepository } from "../../db/repositories/channels";
import { createUserRepository } from "../../db/repositories/users";
import { createWhatsAppGroupRepository } from "../../db/repositories/whatsapp-groups";
import type { DB } from "../../db/schema";
import type { SlackBot } from "../../slack/bot";
import { createTestDb } from "../../test-utils";
import { handleSearchDeliveryTargets } from "./delivery-targets";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

function parseResult(result: Awaited<ReturnType<typeof handleSearchDeliveryTargets>>) {
  return JSON.parse(result.content[0]?.text ?? "{}") as {
    matches: Array<{
      platform: string;
      targetType: string;
      targetId: string;
      label: string;
      canDeliver: boolean;
    }>;
    nextCursor: string | null;
  };
}

function parseMatches(result: Awaited<ReturnType<typeof handleSearchDeliveryTargets>>) {
  return parseResult(result).matches as Array<{
    platform: string;
    targetType: string;
    targetId: string;
    label: string;
    canDeliver: boolean;
  }>;
}

describe("handleSearchDeliveryTargets", () => {
  it("lists deliverable Slack channels when no query is provided", async () => {
    const slack = {
      listChannels: async () => [
        { id: "CGENERAL", name: "general", type: "public_channel", isMember: true },
        { id: "CENG", name: "engineering", type: "public_channel", isMember: true },
        { id: "CRANDOM", name: "random", type: "public_channel", isMember: false },
      ],
    } as SlackBot;

    const matches = parseMatches(
      await handleSearchDeliveryTargets({ platform: "slack" }, { db, getSlack: () => slack }),
    );

    expect(matches).toEqual([
      {
        platform: "slack",
        targetType: "channel",
        targetId: "CGENERAL",
        label: "#general",
        canDeliver: true,
      },
      {
        platform: "slack",
        targetType: "channel",
        targetId: "CENG",
        label: "#engineering",
        canDeliver: true,
      },
    ]);
  });

  it("returns both Slack channels and DMs when filtering only by Slack", async () => {
    const users = createUserRepository(db);
    await users.create({ name: "Alice", email: "alice@test.com", slackUserId: "UALICE" });
    const slack = {
      listChannels: async () => [{ id: "CGENERAL", name: "general", type: "public_channel", isMember: true }],
    } as SlackBot;

    const matches = parseMatches(
      await handleSearchDeliveryTargets({ platform: "slack" }, { db, getSlack: () => slack }),
    );

    expect(matches).toEqual([
      {
        platform: "slack",
        targetType: "channel",
        targetId: "CGENERAL",
        label: "#general",
        canDeliver: true,
      },
      {
        platform: "slack",
        targetType: "dm",
        targetId: "UALICE",
        label: "Alice <alice@test.com>",
        canDeliver: true,
      },
    ]);
  });

  it("paginates results with default limit 10 and an opaque cursor", async () => {
    const slack = {
      listChannels: async () =>
        Array.from({ length: 12 }, (_, index) => ({
          id: `C${String(index + 1).padStart(2, "0")}`,
          name: `channel-${String(index + 1).padStart(2, "0")}`,
          type: "public_channel",
          isMember: true,
        })),
    } as SlackBot;

    const firstPage = parseResult(
      await handleSearchDeliveryTargets({ platform: "slack", targetType: "channel" }, { db, getSlack: () => slack }),
    );
    expect(firstPage.matches.map((match) => match.targetId)).toEqual([
      "C01",
      "C02",
      "C03",
      "C04",
      "C05",
      "C06",
      "C07",
      "C08",
      "C09",
      "C10",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = parseResult(
      await handleSearchDeliveryTargets({ cursor: firstPage.nextCursor ?? undefined }, { db, getSlack: () => slack }),
    );
    expect(secondPage.matches.map((match) => match.targetId)).toEqual(["C11", "C12"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("honors explicit limit", async () => {
    const groups = createWhatsAppGroupRepository(db);
    for (const index of [1, 2, 3]) {
      await groups.upsert({
        jid: `12036300000000${index}@g.us`,
        name: `Group ${index}`,
        description: null,
        updated_at: "2026-06-02T00:00:00.000Z",
      });
    }

    const result = parseResult(await handleSearchDeliveryTargets({ platform: "whatsapp", limit: 2 }, { db }));

    expect(result.matches.map((match) => match.label)).toEqual(["Group 1", "Group 2"]);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("finds only deliverable Slack channels by name when Slack is connected", async () => {
    const slack = {
      listChannels: async () => [
        { id: "CENG", name: "engineering", type: "public_channel", isMember: true },
        { id: "CENGPRIVATE", name: "engineering-private", type: "private_channel", isMember: false },
      ],
    } as SlackBot;

    const matches = parseMatches(
      await handleSearchDeliveryTargets({ query: "#eng", platform: "slack" }, { db, getSlack: () => slack }),
    );

    expect(matches).toEqual([
      {
        platform: "slack",
        targetType: "channel",
        targetId: "CENG",
        label: "#engineering",
        canDeliver: true,
      },
    ]);
  });

  it("does not return cached Slack channels when live Slack is unavailable", async () => {
    const channels = createChannelRepository(db);
    await channels.create({ slackChannelId: "CSTALE", name: "stale-private", type: "private_channel" });

    const matches = parseMatches(
      await handleSearchDeliveryTargets({ platform: "slack", targetType: "channel" }, { db }),
    );

    expect(matches).toEqual([]);
  });

  it("finds Slack DM targets by name, email, or Slack user id", async () => {
    const users = createUserRepository(db);
    await users.create({ name: "Roopak Nijhara", email: "roopak@canvasx.ai", slackUserId: "UROOPAK" });
    await users.create({ name: "Sketch Agent", type: "agent", slackUserId: "UAGENT" });

    const matches = parseMatches(await handleSearchDeliveryTargets({ query: "roopak", platform: "slack" }, { db }));

    expect(matches).toEqual([
      {
        platform: "slack",
        targetType: "dm",
        targetId: "UROOPAK",
        label: "Roopak Nijhara <roopak@canvasx.ai>",
        canDeliver: true,
      },
    ]);
  });

  it("lists Slack DM targets when targetType is dm", async () => {
    const users = createUserRepository(db);
    await users.create({ name: "Alice", email: "alice@test.com", slackUserId: "UALICE" });
    await users.create({ name: "Bob", slackUserId: "UBOB" });

    const matches = parseMatches(await handleSearchDeliveryTargets({ platform: "slack", targetType: "dm" }, { db }));

    expect(matches).toEqual([
      {
        platform: "slack",
        targetType: "dm",
        targetId: "UALICE",
        label: "Alice <alice@test.com>",
        canDeliver: true,
      },
      {
        platform: "slack",
        targetType: "dm",
        targetId: "UBOB",
        label: "Bob",
        canDeliver: true,
      },
    ]);
  });

  it("finds WhatsApp groups by name, description, or JID", async () => {
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: "120363000000001@g.us",
      name: "Ops Leadership",
      description: "incident room",
      updated_at: "2026-06-02T00:00:00.000Z",
    });

    const matches = parseMatches(
      await handleSearchDeliveryTargets({ query: "incident", platform: "whatsapp" }, { db }),
    );

    expect(matches).toEqual([
      {
        platform: "whatsapp",
        targetType: "group",
        targetId: "120363000000001@g.us",
        label: "Ops Leadership",
        canDeliver: true,
      },
    ]);
  });
});
