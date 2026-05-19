import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import {
  AgentEnvironmentVariableShareConflictError,
  createAgentEnvironmentVariableRepository,
} from "./agent-environment-variables";

async function seedUser(db: Kysely<DB>, id: string, name: string, email?: string | null, type = "human") {
  await db
    .insertInto("users")
    .values({ id, name, email: email ?? null, type })
    .execute();
}

async function seedSlackChannel(db: Kysely<DB>, slackChannelId: string, name: string) {
  await db
    .insertInto("channels")
    .values({ id: randomUUID(), slack_channel_id: slackChannelId, name, type: "public_channel" })
    .execute();
}

async function seedWhatsAppGroup(db: Kysely<DB>, jid: string, name: string) {
  await db.insertInto("whatsapp_groups").values({ jid, name, description: null }).execute();
}

describe("Agent environment variable repository sharing", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createAgentEnvironmentVariableRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createAgentEnvironmentVariableRepository(db);
    await seedUser(db, "owner", "Owner", "owner@test.com");
    await seedUser(db, "recipient", "Recipient", "recipient@test.com");
    await seedUser(db, "other-owner", "Other Owner", "other@test.com");
    await seedUser(db, "group-owner", "Group Owner", "group-owner@test.com");
    await seedSlackChannel(db, "C123", "eng");
    await seedWhatsAppGroup(db, "123@g.us", "Product Ops");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("lists owned variables with share metadata and target labels", async () => {
    const variable = await repo.create("owner", { name: "API_TOKEN", value: "secret", isSecret: true });
    await repo.replaceShares(variable.id, "owner", "owner", [
      { type: "org", id: "default" },
      { type: "user", id: "recipient" },
      { type: "slack_channel", id: "C123" },
      { type: "whatsapp_group", id: "123@g.us" },
    ]);

    const variables = await repo.list("owner");

    expect(variables).toEqual([
      expect.objectContaining({
        id: variable.id,
        name: "API_TOKEN",
        value: null,
        shares: [
          expect.objectContaining({
            targetType: "org",
            targetId: "default",
            targetLabel: "Entire org",
            targetSecondaryLabel: null,
          }),
          expect.objectContaining({
            targetType: "user",
            targetId: "recipient",
            targetLabel: "Recipient",
            targetSecondaryLabel: "recipient@test.com",
          }),
          expect.objectContaining({
            targetType: "slack_channel",
            targetId: "C123",
            targetLabel: "#eng",
            targetSecondaryLabel: null,
          }),
          expect.objectContaining({
            targetType: "whatsapp_group",
            targetId: "123@g.us",
            targetLabel: "Product Ops",
            targetSecondaryLabel: null,
          }),
        ],
      }),
    ]);
  });

  it("replaces shares, allows idempotent targets, and rejects duplicate names within the same target", async () => {
    const first = await repo.create("owner", { name: "API_TOKEN", value: "owner-secret", isSecret: true });
    const second = await repo.create("other-owner", { name: "API_TOKEN", value: "other-secret", isSecret: true });

    await repo.replaceShares(first.id, "owner", "owner", [{ type: "slack_channel", id: "C123" }]);
    await repo.replaceShares(first.id, "owner", "owner", [{ type: "slack_channel", id: "C123" }]);

    await expect(
      repo.replaceShares(second.id, "other-owner", "other-owner", [{ type: "slack_channel", id: "C123" }]),
    ).rejects.toBeInstanceOf(AgentEnvironmentVariableShareConflictError);

    await repo.replaceShares(first.id, "owner", "owner", [{ type: "user", id: "recipient" }]);

    const variables = await repo.list("owner");
    expect(variables[0].shares).toEqual([expect.objectContaining({ targetType: "user", targetId: "recipient" })]);
  });

  it("resolves DM runtime env with org, user, and own variables in specificity order", async () => {
    const orgVar = await repo.create("owner", { name: "SHARED_TOKEN", value: "org", isSecret: true });
    const userVar = await repo.create("owner", { name: "USER_TOKEN", value: "user", isSecret: true });
    const shadowed = await repo.create("owner", { name: "PREF", value: "shared", isSecret: true });
    await repo.create("recipient", { name: "PREF", value: "own", isSecret: true });

    await repo.replaceShares(orgVar.id, "owner", "owner", [{ type: "org", id: "default" }]);
    await repo.replaceShares(userVar.id, "owner", "owner", [{ type: "user", id: "recipient" }]);
    await repo.replaceShares(shadowed.id, "owner", "owner", [{ type: "user", id: "recipient" }]);

    const env = await repo.listForRuntimeContext({
      currentUserId: "recipient",
      contextType: "dm",
      taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "D123", createdBy: "recipient" },
    });

    expect(env).toEqual({ SHARED_TOKEN: "org", USER_TOKEN: "user", PREF: "own" });
  });

  it("skips org-shared variables when org scope is disabled", async () => {
    const orgVar = await repo.create("owner", { name: "ORG_TOKEN", value: "org", isSecret: true });
    await repo.replaceShares(orgVar.id, "owner", "owner", [{ type: "org", id: "default" }]);

    const env = await repo.listForRuntimeContext({
      currentUserId: "recipient",
      contextType: "dm",
      allowOrgSharedEnv: false,
      taskContext: {
        platform: "whatsapp",
        contextType: "dm",
        deliveryTarget: "123@s.whatsapp.net",
        createdBy: "recipient",
      },
    });

    expect(env).toEqual({});
  });

  it("resolves channel and group runtime env without requester-owned private variables", async () => {
    const orgVar = await repo.create("owner", { name: "ROUTE_TOKEN", value: "org", isSecret: true });
    const channelVar = await repo.create("other-owner", { name: "ROUTE_TOKEN", value: "channel", isSecret: true });
    const groupVar = await repo.create("group-owner", { name: "ROUTE_TOKEN", value: "group", isSecret: true });
    await repo.create("recipient", { name: "PRIVATE_TOKEN", value: "private", isSecret: true });

    await repo.replaceShares(orgVar.id, "owner", "owner", [{ type: "org", id: "default" }]);
    await repo.replaceShares(channelVar.id, "other-owner", "other-owner", [{ type: "slack_channel", id: "C123" }]);
    await repo.replaceShares(groupVar.id, "group-owner", "group-owner", [{ type: "whatsapp_group", id: "123@g.us" }]);

    const channelEnv = await repo.listForRuntimeContext({
      currentUserId: "recipient",
      contextType: "channel_mention",
      taskContext: { platform: "slack", contextType: "channel", deliveryTarget: "C123", createdBy: "recipient" },
    });
    const groupEnv = await repo.listForRuntimeContext({
      currentUserId: "recipient",
      contextType: "channel_mention",
      taskContext: { platform: "whatsapp", contextType: "group", deliveryTarget: "123@g.us", createdBy: "recipient" },
    });

    expect(channelEnv).toEqual({ ROUTE_TOKEN: "channel" });
    expect(groupEnv).toEqual({ ROUTE_TOKEN: "group" });
  });

  it("preserves creator-owned private variables for scheduled channel and group workflows", async () => {
    const channelVar = await repo.create("other-owner", { name: "ROUTE_TOKEN", value: "channel", isSecret: true });
    const groupVar = await repo.create("group-owner", { name: "ROUTE_TOKEN", value: "group", isSecret: true });
    await repo.create("recipient", { name: "PRIVATE_TOKEN", value: "private", isSecret: true });

    await repo.replaceShares(channelVar.id, "other-owner", "other-owner", [{ type: "slack_channel", id: "C123" }]);
    await repo.replaceShares(groupVar.id, "group-owner", "group-owner", [{ type: "whatsapp_group", id: "123@g.us" }]);

    const channelEnv = await repo.listForRuntimeContext({
      currentUserId: "recipient",
      contextType: "scheduled_task",
      taskContext: { platform: "slack", contextType: "channel", deliveryTarget: "C123", createdBy: "recipient" },
    });
    const groupEnv = await repo.listForRuntimeContext({
      currentUserId: "recipient",
      contextType: "scheduled_task",
      taskContext: { platform: "whatsapp", contextType: "group", deliveryTarget: "123@g.us", createdBy: "recipient" },
    });

    expect(channelEnv).toEqual({ ROUTE_TOKEN: "channel", PRIVATE_TOKEN: "private" });
    expect(groupEnv).toEqual({ ROUTE_TOKEN: "group", PRIVATE_TOKEN: "private" });
  });

  it("returns null when replacing shares for a variable not owned by the user", async () => {
    const variable = await repo.create("owner", { name: "API_TOKEN", value: "secret", isSecret: true });

    const result = await repo.replaceShares(variable.id, "recipient", "recipient", [{ type: "org", id: "default" }]);

    expect(result).toBeNull();
  });
});
