import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import type { DB, EntitiesTable } from "../schema";
import { createEntityRepository, normalizeContactPointValue } from "./entities";

type ResolverDb = Kysely<DB> | Transaction<DB>;
type PersonEntity = Selectable<EntitiesTable>;

async function loadLinkedEntities(db: ResolverDb, entityIds: string[]): Promise<Map<string, PersonEntity | null>> {
  const entitiesById = new Map<string, PersonEntity>();
  let pendingIds = new Set(entityIds);
  while (pendingIds.size > 0) {
    const rows = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "in", [...pendingIds])
      .execute();
    pendingIds = new Set();
    for (const entity of rows) {
      entitiesById.set(entity.id, entity);
      if (entity.merged_into_entity_id && !entitiesById.has(entity.merged_into_entity_id)) {
        pendingIds.add(entity.merged_into_entity_id);
      }
    }
  }

  const resolved = new Map<string, PersonEntity | null>();
  for (const entityId of entityIds) {
    const visited = new Set<string>();
    let currentId: string | null = entityId;
    let liveEntity: PersonEntity | null = null;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const entity = entitiesById.get(currentId);
      if (!entity || entity.source_type !== "person") {
        liveEntity = null;
        break;
      }
      if (entity.merged_into_entity_id) {
        currentId = entity.merged_into_entity_id;
        continue;
      }
      liveEntity = entity.deleted_at === null ? entity : null;
      break;
    }
    resolved.set(entityId, liveEntity);
  }
  return resolved;
}

export async function resolvePersonEntitiesForUser(
  db: ResolverDb,
  userId: string,
  fallbackEmails: string[],
): Promise<Map<string, PersonEntity[]>> {
  const link = await db
    .selectFrom("user_entity_links")
    .select("entity_id")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!link) return createEntityRepository(db).getPersonEntitiesByEmails(fallbackEmails);
  const entity = (await loadLinkedEntities(db, [link.entity_id])).get(link.entity_id) ?? null;
  if (!entity) return createEntityRepository(db).getPersonEntitiesByEmails(fallbackEmails);
  if (fallbackEmails.length === 0) return new Map([[`user:${userId}`, [entity]]]);
  return new Map(fallbackEmails.map((email) => [email, [entity]]));
}

export async function resolvePersonEntitiesForEmails(
  db: ResolverDb,
  emails: string[],
): Promise<Map<string, PersonEntity[]>> {
  const fallback = await createEntityRepository(db).getPersonEntitiesByEmails(emails);
  if (emails.length === 0) return fallback;
  const normalizedEmails = [...new Set(emails.map((email) => normalizeContactPointValue("email", email)))];
  const users = await db
    .selectFrom("users")
    .select(["id", "email"])
    .where("type", "=", "human")
    .where("email", "is not", null)
    .where(sql<boolean>`lower(trim(email)) in (${sql.join(normalizedEmails.map((email) => sql.lit(email)))})`)
    .execute();
  if (users.length === 0) return fallback;
  const links = await db
    .selectFrom("user_entity_links")
    .select(["user_id", "entity_id"])
    .where(
      "user_id",
      "in",
      users.map((user) => user.id),
    )
    .execute();
  const entitiesByLink = await loadLinkedEntities(
    db,
    links.map((link) => link.entity_id),
  );
  const linkByUserId = new Map(links.map((link) => [link.user_id, link]));
  const linkedByEmail = new Map<string, PersonEntity>();
  for (const user of users) {
    if (!user.email) continue;
    const link = linkByUserId.get(user.id);
    if (!link) continue;
    const entity = entitiesByLink.get(link.entity_id) ?? null;
    if (entity) linkedByEmail.set(user.email.trim().toLowerCase(), entity);
  }
  return new Map(
    [...fallback.entries()].map(([email, entities]) => {
      const linked = linkedByEmail.get(email.trim().toLowerCase());
      return [email, linked ? [linked] : entities];
    }),
  );
}
