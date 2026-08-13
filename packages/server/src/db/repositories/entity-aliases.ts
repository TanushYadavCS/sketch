import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { parseAliasesString } from "../../entities/materialize-json";
import type { DB } from "../schema";

const MAX_ALIAS_MERGE_ATTEMPTS = 8;

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
