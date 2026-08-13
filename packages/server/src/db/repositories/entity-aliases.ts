import type { Kysely } from "kysely";
import { parseAliasesString } from "../../entities/materialize-json";
import type { DB } from "../schema";

const MAX_ALIAS_MERGE_ATTEMPTS = 8;

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
  identityValues: Array<string | null | undefined>,
  now = new Date().toISOString(),
): Promise<void> {
  const names = candidates
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  if (names.length === 0) return;
  const fallbackNames = new Set(
    identityValues.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value)),
  );
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
    if (!entity) return;
    if (!fallbackNames.has(entity.name.trim().toLowerCase())) {
      await mergeEntityAliases(db, entityId, names, now);
      return;
    }

    const aliases = parseAliasesString(entity.aliases);
    const seen = new Set(aliases.map((alias) => alias.trim().toLowerCase()));
    if (!seen.has(entity.name.trim().toLowerCase())) aliases.push(entity.name);
    const update = await db
      .updateTable("entities")
      .set({ name: names[0], aliases: JSON.stringify(aliases), updated_at: now })
      .where("id", "=", entity.id)
      .where("name", "=", entity.name)
      .$if(entity.aliases === null, (query) => query.where("aliases", "is", null))
      .$if(entity.aliases !== null, (query) => query.where("aliases", "=", entity.aliases))
      .executeTakeFirst();
    if (Number(update.numUpdatedRows) > 0) {
      await mergeEntityAliases(db, entityId, names.slice(1), now);
      return;
    }
  }
  throw new Error(`WhatsApp roster name enrichment remained contended for ${entityId}`);
}
