import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import type { AgentOutputItemInput } from "./agent-outputs";
import { createAgentOutputRepository } from "./agent-outputs";

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
    structuredPayload: { messageIds: [`message-${params.title.toLowerCase()}`], sourceLabels: ["#launch"] },
    sortOrder: 0,
  };
  await repo.completeOutput({
    outputId: running.row.id,
    masthead: { title: "Summary", summary: "Summary" },
    rawPayload: { summaryWindow: { start: "2026-07-04T00:00:00.000Z", end: params.generatedAt } },
    items: [item],
  });
  await db
    .updateTable("agent_outputs")
    .set({ generated_at: params.generatedAt, updated_at: params.generatedAt })
    .where("id", "=", running.row.id)
    .execute();
  return running.row.id;
}
