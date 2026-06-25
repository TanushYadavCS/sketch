/**
 * Renames the `openrouter_bedrock` LLM provider to `openrouter`.
 *
 * The original name implied OpenRouter-to-Bedrock routing, but the routing
 * preset actually lives inside `model_id` (the `<model>@preset/<alias>`
 * composite), and the provider now serves arbitrary OpenRouter models. This is
 * a pure value rename; the runner's env wiring is unchanged. A plain UPDATE is
 * portable across SQLite and Postgres.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE settings SET llm_provider = 'openrouter' WHERE llm_provider = 'openrouter_bedrock'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE settings SET llm_provider = 'openrouter_bedrock' WHERE llm_provider = 'openrouter'`.execute(db);
}
