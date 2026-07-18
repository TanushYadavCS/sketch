import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import type { AgentOutputItemInput } from "./agent-outputs";
import { createAgentOutputRepository, extractSummarizerSeedCandidates } from "./agent-outputs";

describe("createAgentOutputRepository output scopes", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("coalesces running rows per source while allowing other scopes and completed history", async () => {
    const repo = createAgentOutputRepository(db);
    const base = {
      agentKey: "conversation_summary",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-04",
      timezone: "UTC",
      triggerType: "manual" as const,
    };

    const sourceA = await repo.createRunning({
      ...base,
      sourceKey: "slack:channel:C_A",
      sourceLabel: "#a",
    });
    const duplicateSourceA = await repo.createRunning({
      ...base,
      sourceKey: "slack:channel:C_A",
      sourceLabel: "#a",
    });
    const sourceB = await repo.createRunning({
      ...base,
      sourceKey: "slack:channel:C_B",
      sourceLabel: "#b",
    });

    expect(sourceA.created).toBe(true);
    expect(duplicateSourceA.created).toBe(false);
    expect(duplicateSourceA.row.id).toBe(sourceA.row.id);
    expect(sourceB.created).toBe(true);

    await repo.completeOutput({
      outputId: sourceA.row.id,
      masthead: { title: "A", summary: "A" },
      rawPayload: {},
      items: [],
    });
    const rerunSourceA = await repo.createRunning({
      ...base,
      sourceKey: "slack:channel:C_A",
      sourceLabel: "#a",
    });

    const running = await db
      .selectFrom("agent_outputs")
      .select(["source_key", "status"])
      .where("agent_key", "=", base.agentKey)
      .where("user_id", "=", base.userId)
      .where("output_date", "=", base.outputDate)
      .where("status", "=", "running")
      .orderBy("source_key", "asc")
      .execute();

    expect(rerunSourceA.created).toBe(true);
    expect(running).toEqual([
      { source_key: "slack:channel:C_A", status: "running" },
      { source_key: "slack:channel:C_B", status: "running" },
    ]);
  });

  it("allows only one caller to promote a scheduled running output", async () => {
    const repo = createAgentOutputRepository(db);
    const running = await repo.createRunning({
      agentKey: "daily_brief",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-04",
      timezone: "UTC",
      triggerType: "scheduled",
    });

    const promotions = await Promise.all([
      repo.promoteRunningToManual("daily_brief", running.row.id),
      repo.promoteRunningToManual("daily_brief", running.row.id),
    ]);

    expect(promotions.filter((row) => row !== undefined)).toHaveLength(1);
    expect(promotions.find((row) => row !== undefined)?.trigger_type).toBe("manual");
    expect(await repo.findById("daily_brief", running.row.id)).toMatchObject({ trigger_type: "manual" });
  });

  it("lists bounded completed outputs for a user and agent since a timestamp oldest first with items", async () => {
    const repo = createAgentOutputRepository(db);
    const base = {
      agentKey: "conversation_summary",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-04",
      timezone: "UTC",
      triggerType: "manual" as const,
    };

    const old = await seedCompletedOutput(repo, db, {
      ...base,
      outputDate: "2026-07-03",
      generatedAt: "2026-07-03T23:00:00.000Z",
      title: "Old action",
    });
    const first = await seedCompletedOutput(repo, db, {
      ...base,
      sourceKey: "slack:channel:C_A",
      generatedAt: "2026-07-04T02:00:00.000Z",
      title: "First action",
    });
    const second = await seedCompletedOutput(repo, db, {
      ...base,
      sourceKey: "slack:channel:C_B",
      generatedAt: "2026-07-04T03:00:00.000Z",
      title: "Second action",
    });
    await seedCompletedOutput(repo, db, {
      ...base,
      userId: "user-2",
      sourceKey: "slack:channel:C_C",
      generatedAt: "2026-07-04T04:00:00.000Z",
      title: "Other user action",
    });
    await seedCompletedOutput(repo, db, {
      ...base,
      agentKey: "daily_brief",
      sourceKey: "slack:channel:C_D",
      generatedAt: "2026-07-04T05:00:00.000Z",
      title: "Other agent action",
    });

    const rows = await repo.listCompletedForUserSince("conversation_summary", "user-1", "2026-07-04T00:00:00.000Z", {
      limit: 10,
    });
    const limited = await repo.listCompletedForUserSince("conversation_summary", "user-1", "2026-07-04T00:00:00.000Z", {
      limit: 1,
    });

    expect(rows.map((entry) => entry.output.id)).toEqual([first, second]);
    expect(rows.flatMap((entry) => entry.items.map((item) => item.title))).toEqual(["First action", "Second action"]);
    expect(rows[0].items[0].structuredPayload).toMatchObject({ messageIds: ["message-first action"] });
    expect(rows.map((entry) => entry.output.id)).not.toContain(old);
    expect(limited.map((entry) => entry.output.id)).toEqual([second]);
  });

  it("lists completed outputs for an exact source scope newest first using generated or updated time", async () => {
    const repo = createAgentOutputRepository(db);
    const base = {
      agentKey: "conversation_summary",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-04",
      timezone: "UTC",
      triggerType: "manual" as const,
      sourceKey: "slack:channel:C_A",
    };

    await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T00:00:00.000Z",
      title: "At boundary",
    });
    const generated = await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T02:00:00.000Z",
      title: "Generated action",
    });
    const updatedFallback = await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T03:00:00.000Z",
      title: "Updated fallback action",
    });
    await db
      .updateTable("agent_outputs")
      .set({ generated_at: null, updated_at: "2026-07-04T04:00:00.000Z" })
      .where("id", "=", updatedFallback)
      .execute();
    await seedCompletedOutput(repo, db, {
      ...base,
      sourceKey: "slack:channel:C_B",
      generatedAt: "2026-07-04T05:00:00.000Z",
      title: "Other source action",
    });
    await seedCompletedOutput(repo, db, {
      ...base,
      userId: "user-2",
      generatedAt: "2026-07-04T06:00:00.000Z",
      title: "Other user action",
    });
    await seedCompletedOutput(repo, db, {
      ...base,
      agentKey: "daily_brief",
      generatedAt: "2026-07-04T07:00:00.000Z",
      title: "Other agent action",
    });

    const rows = await repo.listCompletedForScopeSince(
      "conversation_summary",
      "user-1",
      "slack:channel:C_A",
      "2026-07-04T00:00:00.000Z",
      { limit: 2 },
    );

    expect(rows.map((entry) => entry.output.id)).toEqual([updatedFallback, generated]);
    expect(rows.flatMap((entry) => entry.items.map((item) => item.title))).toEqual([
      "Updated fallback action",
      "Generated action",
    ]);
  });

  it("extracts and deduplicates visible action items with raw task candidates for seeding", async () => {
    const repo = createAgentOutputRepository(db);
    const base = {
      agentKey: "conversation_summary",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-04",
      timezone: "UTC",
      triggerType: "manual" as const,
      sourceKey: "slack:channel:C_A",
    };

    await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T01:00:00.000Z",
      title: "Visible only action",
    });
    await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T02:00:00.000Z",
      title: "Keep customer informed",
      rawItems: [
        seedRawItem("confirm pricing", {
          sourceLabels: ["#launch"],
          messageIds: [902, 901],
          owner: "Mina",
        }),
      ],
    });
    await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T03:00:00.000Z",
      title: "Ship   Launch Plan",
      visiblePayload: { sourceLabels: ["#Launch"], messageIds: [800] },
      rawItems: [
        seedRawItem(" ship launch plan ", { sourceLabels: ["#launch"], messageIds: ["800"] }),
        seedRawItem("Confirm Pricing", { sourceLabels: ["#LAUNCH"], messageIds: [901, 902] }),
        seedRawItem("Ship launch plan", { sourceLabels: ["#launch"], messageIds: [801] }),
      ],
    });

    const outputs = await repo.listCompletedForScopeSince(
      "conversation_summary",
      "user-1",
      "slack:channel:C_A",
      "2026-07-04T00:00:00.000Z",
      { limit: 10 },
    );
    const candidates = extractSummarizerSeedCandidates(outputs);

    expect(candidates.map((candidate) => [candidate.title, candidate.origin])).toEqual([
      ["Ship   Launch Plan", "action_item"],
      ["Confirm Pricing", "task_candidate"],
      ["Ship launch plan", "task_candidate"],
      ["Keep customer informed", "action_item"],
      ["Visible only action", "action_item"],
    ]);
    expect(candidates[0]?.structuredPayload).toEqual({ sourceLabels: ["#Launch"], messageIds: [800] });
    expect(candidates[1]?.structuredPayload).not.toHaveProperty("owner");
  });

  it("lists and resolves opaque DM source options only for the configured user", async () => {
    const repo = createAgentOutputRepository(db);
    await db
      .insertInto("users")
      .values([
        { id: "user-1", name: "Alice", email: "alice@example.com" },
        { id: "user-2", name: "Bob", email: "bob@example.com" },
      ])
      .execute();
    const aliceSlack = await seedDmConversation(db, {
      platform: "slack",
      providerConversationId: "D_ALICE",
      displayName: "Alice",
      senderUserId: "user-1",
      receivedAt: "2026-07-04T02:00:00.000Z",
    });
    const aliceWhatsApp = await seedDmConversation(db, {
      platform: "whatsapp",
      providerConversationId: "dm:+15551234567",
      displayName: "+15551234567",
      senderUserId: "user-1",
      receivedAt: "2026-07-04T03:00:00.000Z",
    });
    const olderAliceWhatsApp = await seedDmConversation(db, {
      platform: "whatsapp",
      providerConversationId: "15551234567@s.whatsapp.net",
      displayName: "+15551234567",
      senderUserId: "user-1",
      receivedAt: "2026-07-04T01:00:00.000Z",
    });
    const bobSlack = await seedDmConversation(db, {
      platform: "slack",
      providerConversationId: "D_BOB",
      displayName: "Bob",
      senderUserId: "user-2",
      receivedAt: "2026-07-04T04:00:00.000Z",
    });

    const dmRepo = repo as typeof repo & {
      listDmSourceOptionsForUser?: (
        userId: string,
      ) => Promise<Array<{ platform: string; targetType: string; targetId: string; label: string | null }>>;
      findDmSourceForUser?: (
        userId: string,
        platform: "slack" | "whatsapp",
        targetId: string,
      ) => Promise<{ platform: string; targetType: string; targetId: string; label: string | null } | undefined>;
    };

    expect(dmRepo.listDmSourceOptionsForUser).toBeTypeOf("function");
    expect(dmRepo.findDmSourceForUser).toBeTypeOf("function");

    await expect(dmRepo.listDmSourceOptionsForUser?.("user-1")).resolves.toEqual([
      {
        platform: "slack",
        targetType: "dm",
        targetId: String(aliceSlack),
        label: "Slack DM with Alice",
      },
      {
        platform: "whatsapp",
        targetType: "dm",
        targetId: String(aliceWhatsApp),
        label: "WhatsApp DM with Alice",
      },
    ]);
    await expect(dmRepo.findDmSourceForUser?.("user-1", "whatsapp", String(olderAliceWhatsApp))).resolves.toEqual({
      platform: "whatsapp",
      targetType: "dm",
      targetId: String(olderAliceWhatsApp),
      label: "WhatsApp DM with Alice",
    });
    await expect(dmRepo.findDmSourceForUser?.("user-1", "slack", String(bobSlack))).resolves.toBeUndefined();
    expect(JSON.stringify(await dmRepo.listDmSourceOptionsForUser?.("user-1"))).not.toContain("15551234567");
  });
});

async function seedCompletedOutput(
  repo: ReturnType<typeof createAgentOutputRepository>,
  db: Kysely<DB>,
  params: {
    agentKey: string;
    agentVersion: string;
    userId: string;
    outputDate: string;
    timezone: string;
    triggerType: "manual";
    generatedAt: string;
    title: string;
    sourceKey?: string;
    visiblePayload?: Record<string, unknown>;
    rawItems?: AgentOutputItemInput[];
  },
): Promise<string> {
  const running = await repo.createRunning({
    agentKey: params.agentKey,
    agentVersion: params.agentVersion,
    userId: params.userId,
    outputDate: params.outputDate,
    timezone: params.timezone,
    triggerType: params.triggerType,
    sourceKey: params.sourceKey,
  });
  const item: AgentOutputItemInput = {
    sectionKey: "action_items",
    title: params.title,
    summary: `${params.title} summary`,
    priority: "medium",
    label: "action_item",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    structuredPayload: params.visiblePayload ?? {
      messageIds: [`message-${params.title.toLowerCase()}`],
      sourceLabels: ["#launch"],
    },
    sortOrder: 0,
  };
  await repo.completeOutput({
    outputId: running.row.id,
    masthead: { title: "Summary", summary: "Summary" },
    rawPayload: {
      summaryWindow: { start: "2026-07-04T00:00:00.000Z", end: params.generatedAt },
      items: params.rawItems ?? [],
    },
    items: [item],
  });
  await db
    .updateTable("agent_outputs")
    .set({ generated_at: params.generatedAt, updated_at: params.generatedAt })
    .where("id", "=", running.row.id)
    .execute();
  return running.row.id;
}

function seedRawItem(title: string, structuredPayload: Record<string, unknown>): AgentOutputItemInput {
  return {
    sectionKey: "task_candidates",
    title,
    summary: `${title.trim()} summary`,
    priority: "medium",
    label: "action_item",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    structuredPayload,
    sortOrder: 0,
  };
}

async function seedDmConversation(
  db: Kysely<DB>,
  params: {
    platform: "slack" | "whatsapp";
    providerConversationId: string;
    displayName: string;
    senderUserId: string;
    receivedAt: string;
  },
): Promise<number> {
  const inserted = await db
    .insertInto("conversations")
    .values({
      platform: params.platform,
      kind: "dm",
      provider_conversation_id: params.providerConversationId,
      display_name: params.displayName,
      updated_at: params.receivedAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("conversation_messages")
    .values({
      conversation_id: inserted.id,
      provider_message_id: `message-${inserted.id}`,
      sender_jid: params.providerConversationId,
      sender_name: params.displayName,
      sender_user_id: params.senderUserId,
      is_bot: 0,
      addressed_to_sketch: 1,
      text: "Hello Sketch",
      received_at: params.receivedAt,
    })
    .execute();
  return inserted.id;
}
