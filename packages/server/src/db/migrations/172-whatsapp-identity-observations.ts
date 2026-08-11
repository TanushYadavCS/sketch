import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

async function addUserIdentityTables(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("whatsapp_lid_attempted_at", "text").execute();
  await db.schema.alterTable("users").addColumn("whatsapp_lid_checked_at", "text").execute();
  await db.schema
    .createTable("user_whatsapp_lids")
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("lid", "text", (col) => col.notNull())
    .addColumn("first_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("user_whatsapp_lids_pk", ["user_id", "lid"])
    .addUniqueConstraint("user_whatsapp_lids_lid_uidx", ["lid"])
    .execute();
  await sql`
    INSERT INTO user_whatsapp_lids (user_id, lid, first_seen_at, last_seen_at)
    SELECT id, whatsapp_lid, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
    FROM users
    WHERE whatsapp_lid IS NOT NULL
  `.execute(db);
  await sql`
    INSERT INTO entity_contact_points
      (id, entity_id, kind, value, display_value, label, is_primary, source,
       connector_config_id, created_by_user_id, verified_at, last_contacted_at, created_at, updated_at)
    SELECT
      'whatsapp-phone:' || links.entity_id || ':' || users.id,
      links.entity_id, 'phone', users.whatsapp_number, users.whatsapp_number, NULL,
      CASE WHEN EXISTS (
        SELECT 1 FROM entity_contact_points existing
        WHERE existing.entity_id = links.entity_id AND existing.kind = 'phone' AND existing.is_primary = 1
      ) THEN 0 ELSE 1 END,
      'whatsapp_identity',
      NULL, users.id, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM users
    JOIN user_entity_links links ON links.user_id = users.id
    WHERE users.whatsapp_number IS NOT NULL
    ON CONFLICT (entity_id, kind, value) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO entity_contact_points
      (id, entity_id, kind, value, display_value, label, is_primary, source,
       connector_config_id, created_by_user_id, verified_at, last_contacted_at, created_at, updated_at)
    SELECT
      'whatsapp-lid:' || links.entity_id || ':' || lids.lid,
      links.entity_id, 'whatsapp_lid', lids.lid, lids.lid, NULL,
      CASE WHEN ROW_NUMBER() OVER (
        PARTITION BY lids.user_id ORDER BY lids.last_seen_at DESC, lids.lid ASC
      ) = 1 THEN 1 ELSE 0 END,
      'whatsapp_identity', NULL, lids.user_id, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM user_whatsapp_lids lids
    JOIN user_entity_links links ON links.user_id = lids.user_id
    WHERE 1 = 1
    ON CONFLICT (entity_id, kind, value) DO NOTHING
  `.execute(db);
}

async function rebuildParticipantsSqlite(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("whatsapp_group_participants_v2")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("group_jid", "text", (col) => col.notNull().references("whatsapp_groups.jid").onDelete("cascade"))
    .addColumn("observation_key", "text", (col) => col.notNull())
    .addColumn("participant_jid", "text", (col) => col.notNull())
    .addColumn("phone_e164", "text")
    .addColumn("lid", "text")
    .addColumn("admin_role", "text")
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("whatsapp_group_participants_group_observation_uidx", ["group_jid", "observation_key"])
    .addCheckConstraint(
      "whatsapp_group_participants_admin_role_check",
      sql`admin_role IS NULL OR admin_role IN ('admin', 'superadmin')`,
    )
    .execute();
  await sql`
    INSERT INTO whatsapp_group_participants_v2
      (id, group_jid, observation_key, participant_jid, phone_e164, lid, admin_role, last_seen_at)
    SELECT
      'legacy:' || group_jid || ':' || participant_jid,
      group_jid, observation_key, participant_jid, phone_e164, lid, admin_role, last_seen_at
    FROM (
      SELECT *,
        'phone:' || COALESCE(phone_e164, '-') || '|lid:' || COALESCE(lid, '-') AS observation_key,
        ROW_NUMBER() OVER (
          PARTITION BY group_jid, phone_e164, lid
          ORDER BY last_seen_at DESC, participant_jid ASC
        ) AS duplicate_rank
      FROM whatsapp_group_participants
    ) ranked
    WHERE duplicate_rank = 1
  `.execute(db);
  await db.schema.dropTable("whatsapp_group_participants").execute();
  await db.schema.alterTable("whatsapp_group_participants_v2").renameTo("whatsapp_group_participants").execute();
  await createParticipantIndexes(db);
}

async function alterParticipantsPostgres(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_group_participants").addColumn("id", "text").execute();
  await db.schema.alterTable("whatsapp_group_participants").addColumn("observation_key", "text").execute();
  await sql`
    UPDATE whatsapp_group_participants
    SET id = 'legacy:' || group_jid || ':' || participant_jid,
        observation_key = 'phone:' || COALESCE(phone_e164, '-') || '|lid:' || COALESCE(lid, '-')
  `.execute(db);
  await sql`
    DELETE FROM whatsapp_group_participants
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY group_jid, observation_key
          ORDER BY last_seen_at DESC, id ASC
        ) AS duplicate_rank
        FROM whatsapp_group_participants
      ) ranked
      WHERE duplicate_rank > 1
    )
  `.execute(db);
  await sql`ALTER TABLE whatsapp_group_participants ALTER COLUMN id SET NOT NULL`.execute(db);
  await sql`ALTER TABLE whatsapp_group_participants ALTER COLUMN observation_key SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE whatsapp_group_participants
    DROP CONSTRAINT whatsapp_group_participants_group_participant_uidx
  `.execute(db);
  await db.schema
    .alterTable("whatsapp_group_participants")
    .addPrimaryKeyConstraint("whatsapp_group_participants_pk", ["id"])
    .execute();
  await db.schema
    .alterTable("whatsapp_group_participants")
    .addUniqueConstraint("whatsapp_group_participants_group_observation_uidx", ["group_jid", "observation_key"])
    .execute();
  await db.schema.dropIndex("idx_whatsapp_group_participants_group").execute();
  await db.schema.dropIndex("idx_whatsapp_group_participants_phone").execute();
  await createParticipantIndexes(db);
}

async function createParticipantIndexes(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_whatsapp_group_participants_group")
    .on("whatsapp_group_participants")
    .column("group_jid")
    .execute();
  await db.schema
    .createIndex("idx_whatsapp_group_participants_phone")
    .on("whatsapp_group_participants")
    .columns(["group_jid", "phone_e164"])
    .execute();
  await db.schema
    .createIndex("idx_whatsapp_group_participants_lid")
    .on("whatsapp_group_participants")
    .columns(["group_jid", "lid"])
    .execute();
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await addUserIdentityTables(db);
  if (isPg(db)) await alterParticipantsPostgres(db);
  else await rebuildParticipantsSqlite(db);
}

/**
 * Rollback necessarily loses accumulated observations when several rows share
 * one provider participant JID. The newest row wins, with observation key and
 * surrogate ID providing deterministic tie-breakers.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("whatsapp_group_participants_legacy")
    .addColumn("group_jid", "text", (col) => col.notNull().references("whatsapp_groups.jid").onDelete("cascade"))
    .addColumn("participant_jid", "text", (col) => col.notNull())
    .addColumn("phone_e164", "text")
    .addColumn("lid", "text")
    .addColumn("admin_role", "text")
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("whatsapp_group_participants_group_participant_uidx", ["group_jid", "participant_jid"])
    .addCheckConstraint(
      "whatsapp_group_participants_admin_role_check",
      sql`admin_role IS NULL OR admin_role IN ('admin', 'superadmin')`,
    )
    .execute();
  await sql`
    INSERT INTO whatsapp_group_participants_legacy
      (group_jid, participant_jid, phone_e164, lid, admin_role, last_seen_at)
    SELECT group_jid, participant_jid, phone_e164, lid, admin_role, last_seen_at
    FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY group_jid, participant_jid
        ORDER BY last_seen_at DESC, observation_key ASC, id ASC
      ) AS rollback_rank
      FROM whatsapp_group_participants
    ) ranked
    WHERE rollback_rank = 1
  `.execute(db);
  await db.schema.dropTable("whatsapp_group_participants").execute();
  await db.schema.alterTable("whatsapp_group_participants_legacy").renameTo("whatsapp_group_participants").execute();
  await db.schema
    .createIndex("idx_whatsapp_group_participants_group")
    .on("whatsapp_group_participants")
    .column("group_jid")
    .execute();
  await db.schema
    .createIndex("idx_whatsapp_group_participants_phone")
    .on("whatsapp_group_participants")
    .columns(["group_jid", "phone_e164"])
    .execute();
  await sql`
    DELETE FROM entity_contact_points
    WHERE source = 'whatsapp_identity' AND kind IN ('phone', 'whatsapp_lid')
  `.execute(db);
  await db.schema.dropTable("user_whatsapp_lids").execute();
  await db.schema.alterTable("users").dropColumn("whatsapp_lid_checked_at").execute();
  await db.schema.alterTable("users").dropColumn("whatsapp_lid_attempted_at").execute();
}
