import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import type { AgentOutputItemInput } from "./agent-outputs";
import { createAgentOutputRepository } from "./agent-outputs";

describe("createAgentOutputRepository output scopes on Postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

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

  it("lists completed outputs for an exact source scope newest first with a bounded limit", async () => {
    const repo = createAgentOutputRepository(db);
    const base = {
      agentKey: "conversation_summary",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-04",
      timezone: "UTC",
      triggerType: "manual" as const,
      sourceKey: "whatsapp:group:launch@g.us",
    };

    const first = await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T02:00:00.000Z",
      title: "First action",
    });
    const latest = await seedCompletedOutput(repo, db, {
      ...base,
      generatedAt: "2026-07-04T03:00:00.000Z",
      title: "Latest action",
    });
    await seedCompletedOutput(repo, db, {
      ...base,
      sourceKey: "whatsapp:group:other@g.us",
      generatedAt: "2026-07-04T04:00:00.000Z",
      title: "Other source action",
    });

    const rows = await repo.listCompletedForScopeSince(
      "conversation_summary",
      "user-1",
      "whatsapp:group:launch@g.us",
      "2026-07-04T00:00:00.000Z",
      { limit: 1 },
    );

    expect(rows.map((entry) => entry.output.id)).toEqual([latest]);
    expect(rows[0]?.items.map((item) => item.title)).toEqual(["Latest action"]);
    expect(rows.map((entry) => entry.output.id)).not.toContain(first);
  });

  it("persists trusted direct links and returns item references on Postgres", async () => {
    await db.insertInto("users").values({ id: "user-direct", name: "Direct User" }).execute();
    await db
      .insertInto("tasks")
      .values({
        id: "task-direct",
        source: "brief",
        title: "Direct task",
        normalized_title: "direct task",
        status: "open",
        status_authority: "local",
        provenance: "brief",
        source_task_id: "direct-task",
        created_by_user_id: "user-direct",
      })
      .execute();
    const repo = createAgentOutputRepository(db);
    const running = await repo.createRunning({
      agentKey: "daily_brief",
      agentVersion: "test",
      userId: "user-direct",
      outputDate: "2026-07-17",
      timezone: "UTC",
      triggerType: "manual",
    });

    const persisted = await repo.completeOutput({
      outputId: running.row.id,
      masthead: { title: "Brief", summary: "Summary" },
      rawPayload: {},
      items: [
        {
          sectionKey: "todos",
          title: "Direct task",
          summary: "Server-linked.",
          priority: "medium",
          label: "todo",
          canonicalTaskId: "task-direct",
          knowledgeRefs: { entityIds: [], fileIds: [] },
          sortOrder: 0,
        },
      ],
    });

    expect(persisted).toEqual([{ id: expect.any(String), sectionKey: "todos", sortOrder: 0 }]);
    await expect(
      db
        .selectFrom("agent_output_items")
        .select(["id", "task_id"])
        .where("agent_output_id", "=", running.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ id: persisted[0]?.id, task_id: "task-direct" });
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
    sourceKey: string;
  },
): Promise<string> {
  const running = await repo.createRunning(params);
  const item: AgentOutputItemInput = {
    sectionKey: "action_items",
    title: params.title,
    summary: `${params.title} summary`,
    priority: "medium",
    label: "action_item",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    structuredPayload: { messageIds: [params.title], sourceLabels: ["Launch"] },
    sortOrder: 0,
  };
  await repo.completeOutput({
    outputId: running.row.id,
    masthead: { title: "Summary", summary: "Summary" },
    rawPayload: { items: [] },
    items: [item],
  });
  await db
    .updateTable("agent_outputs")
    .set({ generated_at: params.generatedAt, updated_at: params.generatedAt })
    .where("id", "=", running.row.id)
    .execute();
  return running.row.id;
}
