import { randomUUID } from "node:crypto";
import { type Transaction, sql } from "kysely";
import type { DB } from "../schema";
import { createEntityRepository, whereLiveEntity } from "./entities";

export type WhatsAppRosterProjectionResult = "created" | "linked" | "disabled" | "ambiguous" | "missing-identity";

export interface WhatsAppRosterProjectionInput {
  groupJid: string;
  phoneE164: string | null;
  lid: string | null;
  observedAt: string;
}

async function matchingPersonIds(db: Transaction<DB>, input: WhatsAppRosterProjectionInput): Promise<Set<string>> {
  const ids = new Set<string>();
  const contactConditions: Array<{ kind: "phone" | "whatsapp_lid"; value: string }> = [];
  if (input.phoneE164) contactConditions.push({ kind: "phone", value: input.phoneE164 });
  if (input.lid) contactConditions.push({ kind: "whatsapp_lid", value: input.lid });
  for (const contact of contactConditions) {
    const rows = await db
      .selectFrom("entity_contact_points")
      .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
      .select("entities.id")
      .where("entities.source_type", "=", "person")
      .where("entity_contact_points.kind", "=", contact.kind)
      .where("entity_contact_points.value", "=", contact.value)
      .where(whereLiveEntity())
      .execute();
    for (const row of rows) ids.add(row.id);
  }
  if (input.phoneE164) {
    const rows = await db
      .selectFrom("users")
      .innerJoin("user_entity_links", "user_entity_links.user_id", "users.id")
      .innerJoin("entities", "entities.id", "user_entity_links.entity_id")
      .select("entities.id")
      .where("users.whatsapp_number", "=", input.phoneE164)
      .where("entities.source_type", "=", "person")
      .where(whereLiveEntity())
      .execute();
    for (const row of rows) ids.add(row.id);
  }
  if (input.lid) {
    const rows = await db
      .selectFrom("user_whatsapp_lids")
      .innerJoin("user_entity_links", "user_entity_links.user_id", "user_whatsapp_lids.user_id")
      .innerJoin("entities", "entities.id", "user_entity_links.entity_id")
      .select("entities.id")
      .where("user_whatsapp_lids.lid", "=", input.lid)
      .where("entities.source_type", "=", "person")
      .where(whereLiveEntity())
      .execute();
    for (const row of rows) ids.add(row.id);
  }
  return ids;
}

async function upsertIdentityContactPoint(
  db: Transaction<DB>,
  entityId: string,
  kind: "phone" | "whatsapp_lid",
  value: string,
  observedAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      kind,
      value,
      display_value: value,
      label: null,
      is_primary: 1,
      source: "whatsapp_identity",
      connector_config_id: null,
      created_by_user_id: null,
      verified_at: null,
      last_contacted_at: observedAt,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["entity_id", "kind", "value"]).doUpdateSet({
        display_value: sql`COALESCE(entity_contact_points.display_value, excluded.display_value)`,
        source: "whatsapp_identity",
        last_contacted_at: sql`CASE
          WHEN entity_contact_points.last_contacted_at IS NULL OR excluded.last_contacted_at > entity_contact_points.last_contacted_at
          THEN excluded.last_contacted_at
          ELSE entity_contact_points.last_contacted_at
        END`,
        updated_at: now,
      }),
    )
    .execute();
}

export async function projectWhatsAppRosterPerson(
  db: Transaction<DB>,
  input: WhatsAppRosterProjectionInput,
): Promise<WhatsAppRosterProjectionResult> {
  if (!input.phoneE164 && !input.lid) return "missing-identity";
  const group = await db
    .selectFrom("whatsapp_groups")
    .select("index_enabled")
    .where("jid", "=", input.groupJid)
    .executeTakeFirst();
  if (group?.index_enabled !== 1) return "disabled";

  const matches = await matchingPersonIds(db, input);
  if (matches.size > 1) return "ambiguous";
  const repo = createEntityRepository(db);
  const created = matches.size === 0;
  const entity = created
    ? await repo.upsertPersonEntity({
        name: input.phoneE164 ?? (input.lid as string),
        subtype: "external",
        source: "whatsapp_identity",
        sourceId: input.phoneE164 ? `phone:${input.phoneE164}` : `lid:${input.lid}`,
        provenanceTier: "inferred",
      })
    : await db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", [...matches][0])
        .executeTakeFirstOrThrow();

  if (input.phoneE164) {
    await upsertIdentityContactPoint(db, entity.id, "phone", input.phoneE164, input.observedAt);
    await repo.upsertSourceRef({
      entityId: entity.id,
      source: "whatsapp_identity",
      sourceId: `phone:${input.phoneE164}`,
    });
  }
  if (input.lid) {
    await upsertIdentityContactPoint(db, entity.id, "whatsapp_lid", input.lid, input.observedAt);
    await repo.upsertSourceRef({
      entityId: entity.id,
      source: "whatsapp_identity",
      sourceId: `lid:${input.lid}`,
    });
  }
  return created ? "created" : "linked";
}
