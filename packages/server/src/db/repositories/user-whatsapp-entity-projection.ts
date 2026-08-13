import { randomUUID } from "node:crypto";
import { type Kysely, type Transaction, sql } from "kysely";
import type { DB } from "../schema";
import { normalizeContactPointValue } from "./entities";

type ProjectionDb = Kysely<DB> | Transaction<DB>;

type WhatsAppEntityPoint = {
  kind: "phone" | "whatsapp_lid";
  value: string;
  displayValue: string;
  primary: boolean;
};

async function upsertWhatsAppEntityPoint(
  db: ProjectionDb,
  entityId: string,
  userId: string,
  point: WhatsAppEntityPoint,
): Promise<void> {
  const now = new Date().toISOString();
  if (point.primary) {
    await db
      .updateTable("entity_contact_points")
      .set({ is_primary: 0, updated_at: now })
      .where("entity_id", "=", entityId)
      .where("kind", "=", point.kind)
      .where("value", "!=", point.value)
      .execute();
  }
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      kind: point.kind,
      value: point.value,
      display_value: point.displayValue,
      label: null,
      is_primary: point.primary ? 1 : 0,
      source: "whatsapp_identity",
      connector_config_id: null,
      created_by_user_id: userId,
      verified_at: null,
      last_contacted_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["entity_id", "kind", "value"]).doUpdateSet({
        display_value: sql`CASE
          WHEN entity_contact_points.created_by_user_id = ${userId}
            AND entity_contact_points.source IN ('sketch_user', 'whatsapp_identity')
          THEN COALESCE(entity_contact_points.display_value, excluded.display_value)
          ELSE entity_contact_points.display_value
        END`,
        is_primary: sql`CASE
          WHEN entity_contact_points.created_by_user_id = ${userId}
            AND entity_contact_points.source IN ('sketch_user', 'whatsapp_identity')
          THEN ${point.primary ? 1 : 0}
          ELSE entity_contact_points.is_primary
        END`,
        updated_at: sql`CASE
          WHEN entity_contact_points.created_by_user_id = ${userId}
            AND entity_contact_points.source IN ('sketch_user', 'whatsapp_identity')
          THEN ${now}
          ELSE entity_contact_points.updated_at
        END`,
      }),
    )
    .execute();
}

/**
 * Projects the user's current WhatsApp phone and every retained LID onto the
 * linked person. These rows are durable enrichment only; user identity tables
 * remain the authorization source and entity linking ignores whatsapp_lid.
 */
async function projectUserWhatsAppIdentityToEntityInTransaction(
  db: ProjectionDb,
  userId: string,
  knownEntityId?: string,
): Promise<boolean> {
  const guarded = await db.updateTable("users").set({ name: sql`name` }).where("id", "=", userId).executeTakeFirst();
  if (Number(guarded.numUpdatedRows) === 0) return false;

  const entityId =
    knownEntityId ??
    (await db.selectFrom("user_entity_links").select("entity_id").where("user_id", "=", userId).executeTakeFirst())
      ?.entity_id;
  if (!entityId) return false;

  if (!knownEntityId) {
    const entity = await db
      .selectFrom("entities")
      .select("id")
      .where("id", "=", entityId)
      .where("source_type", "=", "person")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!entity) return false;
  }

  const user = await db.selectFrom("users").select("whatsapp_number").where("id", "=", userId).executeTakeFirst();
  if (!user) return false;

  const aliases = await db
    .selectFrom("user_whatsapp_lids")
    .select(["lid", "last_seen_at"])
    .where("user_id", "=", userId)
    .orderBy("last_seen_at", "desc")
    .orderBy("lid", "asc")
    .execute();
  const phone = user.whatsapp_number ? normalizeContactPointValue("phone", user.whatsapp_number) : null;
  await db
    .deleteFrom("entity_contact_points")
    .where("entity_id", "=", entityId)
    .where("kind", "=", "phone")
    .where("source", "in", ["sketch_user", "whatsapp_identity"])
    .where("created_by_user_id", "=", userId)
    .$if(Boolean(phone), (query) => query.where("value", "!=", phone ?? ""))
    .execute();
  if (phone && user.whatsapp_number) {
    const exactPhone = await db
      .selectFrom("entity_contact_points")
      .select(["source", "created_by_user_id", "is_primary"])
      .where("entity_id", "=", entityId)
      .where("kind", "=", "phone")
      .where("value", "=", phone)
      .executeTakeFirst();
    const primaryPhone = await db
      .selectFrom("entity_contact_points")
      .select("id")
      .where("entity_id", "=", entityId)
      .where("kind", "=", "phone")
      .where("is_primary", "=", 1)
      .executeTakeFirst();
    const exactPhoneIsUserOwned =
      exactPhone?.created_by_user_id === userId &&
      (exactPhone.source === "sketch_user" || exactPhone.source === "whatsapp_identity");
    await upsertWhatsAppEntityPoint(db, entityId, userId, {
      kind: "phone",
      value: phone,
      displayValue: user.whatsapp_number,
      primary: !primaryPhone || (exactPhoneIsUserOwned && exactPhone.is_primary === 1),
    });
  }

  for (const [index, alias] of aliases.entries()) {
    await upsertWhatsAppEntityPoint(db, entityId, userId, {
      kind: "whatsapp_lid",
      value: alias.lid,
      displayValue: alias.lid,
      primary: index === 0,
    });
  }
  return true;
}

export async function projectUserWhatsAppIdentityToEntity(
  db: ProjectionDb,
  userId: string,
  knownEntityId?: string,
): Promise<boolean> {
  if (db.isTransaction) return projectUserWhatsAppIdentityToEntityInTransaction(db, userId, knownEntityId);
  return db
    .transaction()
    .execute((trx) => projectUserWhatsAppIdentityToEntityInTransaction(trx, userId, knownEntityId));
}
