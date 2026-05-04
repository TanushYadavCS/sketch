/**
 * Adds users.allowed_tools — JSON array of canonical tool names an agent is
 * permitted to invoke. Enforced at runtime in canUseTool when a run is
 * associated with an agent. NULL for non-agent rows.
 *
 * Existing type='agent' rows are back-filled with the full built-in toolset
 * so allowlist enforcement does not strip capability from agents that were
 * created before this column existed.
 */
import { type Kysely, sql } from "kysely";

const DEFAULT_AGENT_BUILT_IN_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("allowed_tools", "text").execute();

  const defaults = JSON.stringify(DEFAULT_AGENT_BUILT_IN_TOOLS);
  await sql`UPDATE users SET allowed_tools = ${defaults} WHERE type = 'agent'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("allowed_tools").execute();
}
