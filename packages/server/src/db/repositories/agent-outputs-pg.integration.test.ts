import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
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
});
