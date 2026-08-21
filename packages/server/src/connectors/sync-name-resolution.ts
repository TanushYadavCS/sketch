import type { Kysely } from "kysely";
import { whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { normalizeName } from "../entities/name-keys";
import { createAmbiguityAwareMap } from "./ambiguity-map";
import { forEachChunk } from "./sync-utils";
import type { NameResolution, NameResolver } from "./types";

/**
 * Read a person entity's email from its JSON metadata column. SQLite and
 * Postgres both store this as a text JSON blob, so parsing in memory avoids
 * dialect-specific JSON extraction in the preload query.
 */
function readPersonEmail(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { email?: unknown };
    if (typeof parsed.email === "string" && parsed.email.length > 0) {
      return parsed.email.toLowerCase();
    }
  } catch {}
  return null;
}

/**
 * Parse person entity aliases from their JSON column. Invalid or absent alias
 * data is ignored so one corrupt row cannot fail a connector sync.
 */
function parseAliases(aliases: string | null): string[] {
  if (!aliases) return [];
  try {
    const parsed = JSON.parse(aliases);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {}
  return [];
}

/**
 * Build a per-sync snapshot resolver for speaker/person names. The users and
 * entities tables are read once, then the returned closure resolves against
 * those snapshots; users or entities added mid-sync become visible on the next
 * sync run, preserving the previous dispatcher semantics.
 */
export async function buildSyncNameResolver(db: Kysely<DB>): Promise<NameResolver> {
  const personRows = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases", "metadata"])
    .where(whereLiveEntity())
    .where("source_type", "=", "person")
    .execute();
  const personEmailByName = createAmbiguityAwareMap<string, { email: string; entityId: string }>();
  await forEachChunk(personRows, async (batch) => {
    for (const p of batch) {
      const email = readPersonEmail(p.metadata);
      if (!email) continue;
      const value = { email, entityId: p.id };
      personEmailByName.add(normalizeName(p.name), value);
      for (const alias of parseAliases(p.aliases)) {
        personEmailByName.add(normalizeName(alias), value);
      }
    }
  });

  const userEmailByName = createAmbiguityAwareMap<string, string>();
  const userRows = await db
    .selectFrom("users")
    .select(["name", "email"])
    .where("email", "is not", null)
    .where("type", "!=", "external")
    .execute();
  for (const u of userRows) {
    if (!u.email) continue;
    userEmailByName.add(normalizeName(u.name), u.email.toLowerCase());
  }

  return (name: string): NameResolution | null => {
    const key = normalizeName(name);
    const userEmail = userEmailByName.get(key);
    if (userEmail) return { email: userEmail, source: "users" };
    const entityHit = personEmailByName.get(key);
    if (entityHit) return { email: entityHit.email, entityId: entityHit.entityId, source: "entities" };
    return null;
  };
}
