import type { Kysely, Selectable } from "kysely";
import type { DB, EntitiesTable } from "../db/schema";

export class EntityRedirectError extends Error {
  constructor(
    public readonly code: "ENTITY_REDIRECT_CYCLE" | "ENTITY_REDIRECT_TOO_DEEP",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EntityRedirectError";
  }
}

export async function resolveLiveEntityId(db: Kysely<DB>, entityId: string): Promise<string> {
  let current = entityId;
  const seen = new Set<string>();

  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(current)) {
      throw new EntityRedirectError("ENTITY_REDIRECT_CYCLE", "entity merge redirect cycle detected", { entityId });
    }
    seen.add(current);

    const row = await db
      .selectFrom("entities")
      .select(["id", "merged_into_entity_id"])
      .where("id", "=", current)
      .executeTakeFirst();
    if (!row?.merged_into_entity_id) return current;
    current = row.merged_into_entity_id;
  }

  throw new EntityRedirectError("ENTITY_REDIRECT_TOO_DEEP", "entity merge redirect chain exceeded limit", { entityId });
}

export async function resolveLiveEntity(db: Kysely<DB>, entityId: string): Promise<Selectable<EntitiesTable> | null> {
  const liveId = await resolveLiveEntityId(db, entityId);
  return (
    (await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", liveId)
      .where("deleted_at", "is", null)
      .where("merged_into_entity_id", "is", null)
      .executeTakeFirst()) ?? null
  );
}

export async function resolveSourceRefToLiveEntityId(
  db: Kysely<DB>,
  source: string,
  sourceId: string,
): Promise<string | null> {
  const ref = await db
    .selectFrom("entity_source_refs")
    .select("entity_id")
    .where("source", "=", source)
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
  if (!ref) return null;
  return resolveLiveEntityId(db, ref.entity_id);
}
