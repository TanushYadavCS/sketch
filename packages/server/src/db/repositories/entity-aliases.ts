import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { parseAliasesString } from "../../entities/materialize-json";
import type { DB } from "../schema";

const MAX_ALIAS_MERGE_ATTEMPTS = 8;

/**
 * The best pending name proposal per entity, for entities still carrying a
 * placeholder name. A WhatsApp-minted person is named after its own phone number
 * until a pushName confirms a real one, so this is what lets a surface render
 * "Tanush Yadav (+919891688787)" instead of the bare digits.
 *
 * Ranking happens in memory rather than via DISTINCT ON or a window function so
 * the query stays portable across SQLite and Postgres. Callers pass at most a
 * page of entity ids, so the row count is bounded by the page size.
 *
 * The empty-input guard is load-bearing, not defensive: an empty list renders as
 * `IN ()`, which SQLite accepts and Postgres rejects as a syntax error.
 */
export async function listPendingNameProposalsByEntity(
  db: Kysely<DB>,
  entityIds: string[],
): Promise<Map<string, string>> {
  const best = new Map<string, string>();
  if (entityIds.length === 0) return best;
  const rows = await db
    .selectFrom("entity_name_proposals")
    .innerJoin("entities", "entities.id", "entity_name_proposals.entity_id")
    .select([
      "entity_name_proposals.entity_id",
      "entity_name_proposals.value",
      "entity_name_proposals.observed_count",
      "entity_name_proposals.last_seen_at",
    ])
    .where("entity_name_proposals.entity_id", "in", entityIds)
    .where("entity_name_proposals.status", "=", "pending")
    .where("entities.name_status", "=", "placeholder")
    .execute();

  const ranked = new Map<string, { value: string; observedCount: number; lastSeenAt: string }>();
  for (const row of rows) {
    const value = row.value.trim();
    if (!value) continue;
    const current = ranked.get(row.entity_id);
    const candidate = { value, observedCount: row.observed_count, lastSeenAt: row.last_seen_at };
    if (
      !current ||
      candidate.observedCount > current.observedCount ||
      (candidate.observedCount === current.observedCount && candidate.lastSeenAt > current.lastSeenAt)
    ) {
      ranked.set(row.entity_id, candidate);
    }
  }
  for (const [entityId, candidate] of ranked) best.set(entityId, candidate.value);
  return best;
}

export async function upsertEntityNameProposal(
  db: Kysely<DB>,
  entityId: string,
  source: string,
  value: string,
  observedAt = new Date().toISOString(),
): Promise<void> {
  const normalizedValue = normalizeName(value);
  if (!normalizedValue) return;
  await db
    .insertInto("entity_name_proposals")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      source,
      value,
      normalized_value: normalizedValue,
      first_seen_at: observedAt,
      last_seen_at: observedAt,
      resolved_by_user_id: null,
      resolved_at: null,
    })
    .onConflict((oc) =>
      oc.columns(["entity_id", "source", "normalized_value"]).doUpdateSet({
        value,
        observed_count: sql`entity_name_proposals.observed_count + 1`,
        last_seen_at: observedAt,
      }),
    )
    .execute();
}

export async function mergeEntityAliases(
  db: Kysely<DB>,
  entityId: string,
  candidates: Array<string | null | undefined>,
  now = new Date().toISOString(),
): Promise<string[]> {
  for (let attempt = 0; attempt < MAX_ALIAS_MERGE_ATTEMPTS; attempt += 1) {
    const entity = await db
      .selectFrom("entities")
      .select(["id", "name", "aliases"])
      .where("id", "=", entityId)
      .where("source_type", "=", "person")
      .where("status", "!=", "archived")
      .where("deleted_at", "is", null)
      .where("merged_into_entity_id", "is", null)
      .executeTakeFirst();
    if (!entity) return [];

    const aliases = parseAliasesString(entity.aliases);
    const seen = new Set([entity.name, ...aliases].map((value) => value.trim().toLowerCase()).filter(Boolean));
    for (const candidate of candidates) {
      const value = candidate?.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      aliases.push(value);
      seen.add(key);
    }
    if (aliases.length === parseAliasesString(entity.aliases).length) return aliases;

    let update = db
      .updateTable("entities")
      .set({ aliases: JSON.stringify(aliases), updated_at: now })
      .where("id", "=", entity.id);
    update =
      entity.aliases === null ? update.where("aliases", "is", null) : update.where("aliases", "=", entity.aliases);
    const result = await update.executeTakeFirst();
    if (result.numUpdatedRows > 0n) return aliases;
  }

  throw new Error(`Entity alias merge remained contended for ${entityId}`);
}

export async function enrichWhatsAppRosterPersonName(
  db: Kysely<DB>,
  entityId: string,
  candidates: Array<string | null | undefined>,
  proposalCandidates: Array<string | null | undefined> = candidates,
  now = new Date().toISOString(),
): Promise<void> {
  const names = candidates
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  if (names.length === 0) return;
  await mergeEntityAliases(db, entityId, names, now);
  for (const name of proposalCandidates
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate))) {
    await upsertEntityNameProposal(db, entityId, "whatsapp_pushname", name, now);
  }
}
