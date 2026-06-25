import type { Kysely } from "kysely";

/**
 * Adds `aux_cost_usd` to agent_runs: the per-run sum of auxiliary LLM sub-call
 * costs (transcription, vision) that are billed separately from the agent's own
 * model cost in `cost_usd`. Total turn cost is `cost_usd + aux_cost_usd`; the
 * per-call breakdown lives in the `attributes` JSON (`sketch.aux_calls`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("agent_runs")
    .addColumn("aux_cost_usd", "real", (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("agent_runs").dropColumn("aux_cost_usd").execute();
}
