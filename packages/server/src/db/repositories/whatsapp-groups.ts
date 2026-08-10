import { randomUUID } from "node:crypto";
import { type Insertable, type Kysely, type Selectable, sql } from "kysely";
import type {
  DB,
  WhatsAppGroupMemberLabelsTable,
  WhatsAppGroupParticipantsTable,
  WhatsAppGroupsTable,
} from "../schema";
import { normalizeContactPointValue } from "./entities";

export type WhatsAppGroupRow = Selectable<WhatsAppGroupsTable>;
export type NewWhatsAppGroup = Insertable<WhatsAppGroupsTable>;
export type WhatsAppGroupMemberLabelRow = Selectable<WhatsAppGroupMemberLabelsTable>;
export type WhatsAppGroupParticipantRow = Selectable<WhatsAppGroupParticipantsTable>;
export type WhatsAppGroupParticipantAdminRole = "admin" | "superadmin";

export interface WhatsAppGroupIndexingConfig {
  jid: string;
  name: string;
  description: string | null;
  indexEnabled: boolean;
  sliceGapMinutes: number | null;
  sliceMaxAgeMinutes: number | null;
  sliceMaxMessages: number | null;
}

export interface WhatsAppGroupIndexingOverrides {
  sliceGapMinutes?: number | null;
  sliceMaxAgeMinutes?: number | null;
  sliceMaxMessages?: number | null;
}

export interface WhatsAppGroupMemberLabelInput {
  groupJid: string;
  phoneE164: string;
  displayName: string;
  companyName?: string | null;
  createdBy: string;
}

export interface WhatsAppGroupParticipantInput {
  participantJid: string;
  phoneE164?: string | null;
  lid?: string | null;
  adminRole?: WhatsAppGroupParticipantAdminRole | null;
}

export interface WhatsAppGroupParticipantRefreshLogger {
  warn: (context: { groupJid: string; storedCount: number; incomingCount: number }, message: string) => void;
}

export function whatsappParticipantObservationKey(phoneE164: string | null, lid: string | null): string {
  return `phone:${phoneE164 ?? "-"}|lid:${lid ?? "-"}`;
}

function normalizedParticipant(participant: WhatsAppGroupParticipantInput) {
  return {
    participantJid: participant.participantJid,
    phoneE164: participant.phoneE164 ? normalizeContactPointValue("whatsapp", participant.phoneE164) : null,
    lid: participant.lid?.trim().toLowerCase() || null,
    adminRole: participant.adminRole ?? null,
  };
}

function toIndexingConfig(row: WhatsAppGroupRow): WhatsAppGroupIndexingConfig {
  return {
    jid: row.jid,
    name: row.name,
    description: row.description,
    indexEnabled: row.index_enabled === 1,
    sliceGapMinutes: row.slice_gap_minutes,
    sliceMaxAgeMinutes: row.slice_max_age_minutes,
    sliceMaxMessages: row.slice_max_messages,
  };
}

/**
 * A group whose indexing was off keeps its kept slices linked to retained
 * files, and emission never selects disabled groups — so nothing would ever
 * refresh that content, even after re-enabling (linked slices outside the
 * 7-day refresh window are skipped). Clearing kept-slice links on the
 * disabled-to-enabled transition requeues them; the emitter re-renders and
 * upserts the same file rows by provider_file_id.
 */
async function requeueKeptSlicesForJids(db: Kysely<DB>, jids: string[]): Promise<void> {
  await requeueKeptSlicesCore(db, jids);
}

export type WhatsAppGroupIndexSelection = Record<string, boolean>;

function enabledJidsFromSelection(selection: WhatsAppGroupIndexSelection): string[] {
  return Object.entries(selection)
    .filter(([, enabled]) => enabled)
    .map(([jid]) => jid);
}

/** Applies only JIDs present in the delta without opening a transaction. */
export async function applyIndexSelection(db: Kysely<DB>, selection: WhatsAppGroupIndexSelection): Promise<void> {
  const enable = enabledJidsFromSelection(selection);
  const disable = Object.entries(selection)
    .filter(([, enabled]) => !enabled)
    .map(([jid]) => jid);

  if (enable.length > 0) {
    const previouslyEnabled = await db
      .selectFrom("whatsapp_groups")
      .select("jid")
      .where("index_enabled", "=", 1)
      .where("jid", "in", enable)
      .execute();
    const previous = new Set(previouslyEnabled.map((row) => row.jid));
    const newlyEnabled = enable.filter((jid) => !previous.has(jid));
    if (newlyEnabled.length > 0) {
      await requeueKeptSlicesCore(db, newlyEnabled);
      await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "in", newlyEnabled).execute();
    }
  }

  if (disable.length > 0) {
    await db
      .updateTable("whatsapp_groups")
      .set({ index_enabled: 0 })
      .where("index_enabled", "=", 1)
      .where("jid", "in", disable)
      .execute();
  }
}

export const WHATSAPP_GROUP_INDEXING_KEY = "groupIndexing";

async function requeueKeptSlicesCore(db: Kysely<DB>, jids: string[]): Promise<void> {
  if (jids.length === 0) return;
  const conversations = await db
    .selectFrom("conversations")
    .select("id")
    .where("platform", "=", "whatsapp")
    .where("kind", "=", "group")
    .where("provider_conversation_id", "in", jids)
    .execute();
  if (conversations.length === 0) return;
  await db
    .updateTable("conversation_slices")
    .set({ indexed_file_id: null })
    .where("salience_verdict", "=", "kept")
    .where("indexed_file_id", "is not", null)
    .where(
      "conversation_id",
      "in",
      conversations.map((row) => row.id),
    )
    .execute();
}

export function createWhatsAppGroupRepository(db: Kysely<DB>) {
  return {
    async getByJid(jid: string): Promise<WhatsAppGroupRow | undefined> {
      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
    },

    async list(): Promise<WhatsAppGroupRow[]> {
      return db.selectFrom("whatsapp_groups").selectAll().orderBy("updated_at", "desc").execute();
    },

    async getIndexingConfig(jid: string): Promise<WhatsAppGroupIndexingConfig | undefined> {
      const row = await db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
      return row ? toIndexingConfig(row) : undefined;
    },

    async listIndexEnabled(): Promise<WhatsAppGroupIndexingConfig[]> {
      const rows = await db
        .selectFrom("whatsapp_groups")
        .selectAll()
        .where("index_enabled", "=", 1)
        .orderBy("updated_at", "desc")
        .execute();
      return rows.map(toIndexingConfig);
    },

    /** Defaults new groups on without changing an existing group's choice. */
    async upsert(group: NewWhatsAppGroup): Promise<WhatsAppGroupRow> {
      await db
        .insertInto("whatsapp_groups")
        .values({ ...group, index_enabled: group.index_enabled ?? 1 })
        .onConflict((oc) =>
          oc.column("jid").doUpdateSet({
            name: group.name,
            description: group.description ?? null,
            tool_progress: group.tool_progress ?? null,
            reasoning_text: group.reasoning_text ?? null,
            updated_at: group.updated_at,
          }),
        )
        .execute();

      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", group.jid).executeTakeFirstOrThrow();
    },

    async updateProgressSettings(
      jid: string,
      settings: { toolProgress?: string | null; reasoningText?: boolean | null },
    ): Promise<WhatsAppGroupRow | undefined> {
      const values: Record<string, unknown> = {};
      if (settings.toolProgress !== undefined) values.tool_progress = settings.toolProgress;
      if (settings.reasoningText !== undefined) {
        values.reasoning_text = settings.reasoningText == null ? null : settings.reasoningText ? 1 : 0;
      }
      if (Object.keys(values).length > 0) {
        await db.updateTable("whatsapp_groups").set(values).where("jid", "=", jid).execute();
      }
      return db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
    },

    async setIndexEnabled(
      jid: string,
      enabled: boolean,
      overrides: WhatsAppGroupIndexingOverrides = {},
    ): Promise<WhatsAppGroupIndexingConfig | undefined> {
      const values: Record<string, unknown> = { index_enabled: enabled ? 1 : 0 };
      if (overrides.sliceGapMinutes !== undefined) values.slice_gap_minutes = overrides.sliceGapMinutes;
      if (overrides.sliceMaxAgeMinutes !== undefined) values.slice_max_age_minutes = overrides.sliceMaxAgeMinutes;
      if (overrides.sliceMaxMessages !== undefined) values.slice_max_messages = overrides.sliceMaxMessages;
      /**
       * Deliberately not wrapped in an explicit transaction: repository
       * methods run inside shared-PGlite test transactions where an inner
       * COMMIT would terminate the outer per-test transaction. Instead the
       * requeue runs BEFORE the enable flip so every partial failure is
       * retryable: if the enable never commits, the group still reads as
       * disabled and a retry replays the (idempotent) requeue; the reverse
       * order would strand roster-stale content forever, because a retry
       * would see index_enabled=1 and skip the transition.
       */
      const before = await db
        .selectFrom("whatsapp_groups")
        .select("index_enabled")
        .where("jid", "=", jid)
        .executeTakeFirst();
      if (enabled && before?.index_enabled === 0) {
        await requeueKeptSlicesForJids(db, [jid]);
      }
      await db.updateTable("whatsapp_groups").set(values).where("jid", "=", jid).execute();
      const row = await db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", jid).executeTakeFirst();
      return row ? toIndexingConfig(row) : undefined;
    },

    async upsertMemberLabel(input: WhatsAppGroupMemberLabelInput): Promise<WhatsAppGroupMemberLabelRow> {
      const phoneE164 = normalizeContactPointValue("whatsapp", input.phoneE164);
      await db
        .insertInto("whatsapp_group_member_labels")
        .values({
          group_jid: input.groupJid,
          phone_e164: phoneE164,
          display_name: input.displayName,
          company_name: input.companyName ?? null,
          created_by: input.createdBy,
        })
        .onConflict((oc) =>
          oc.columns(["group_jid", "phone_e164"]).doUpdateSet({
            display_name: input.displayName,
            company_name: input.companyName ?? null,
            created_by: input.createdBy,
          }),
        )
        .execute();

      return db
        .selectFrom("whatsapp_group_member_labels")
        .selectAll()
        .where("group_jid", "=", input.groupJid)
        .where("phone_e164", "=", phoneE164)
        .executeTakeFirstOrThrow();
    },

    async getMemberLabel(groupJid: string, phoneE164: string): Promise<WhatsAppGroupMemberLabelRow | undefined> {
      const normalizedPhone = normalizeContactPointValue("whatsapp", phoneE164);
      return db
        .selectFrom("whatsapp_group_member_labels")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .where("phone_e164", "=", normalizedPhone)
        .executeTakeFirst();
    },

    async listMemberLabels(groupJid: string): Promise<WhatsAppGroupMemberLabelRow[]> {
      return db
        .selectFrom("whatsapp_group_member_labels")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .orderBy("display_name", "asc")
        .orderBy("phone_e164", "asc")
        .execute();
    },

    async replaceMemberLabels(
      groupJid: string,
      labels: Array<{ phoneE164: string; displayName: string; companyName?: string | null; createdBy: string }>,
    ): Promise<WhatsAppGroupMemberLabelRow[]> {
      const normalizedLabels = labels.map((label) => ({
        ...label,
        phoneE164: normalizeContactPointValue("whatsapp", label.phoneE164),
      }));
      const targetPhones = new Set(normalizedLabels.map((label) => label.phoneE164));
      await db.transaction().execute(async (trx) => {
        if (targetPhones.size === 0) {
          await trx.deleteFrom("whatsapp_group_member_labels").where("group_jid", "=", groupJid).execute();
        } else {
          await trx
            .deleteFrom("whatsapp_group_member_labels")
            .where("group_jid", "=", groupJid)
            .where("phone_e164", "not in", [...targetPhones])
            .execute();
        }

        for (const label of normalizedLabels) {
          await trx
            .insertInto("whatsapp_group_member_labels")
            .values({
              group_jid: groupJid,
              phone_e164: label.phoneE164,
              display_name: label.displayName,
              company_name: label.companyName ?? null,
              created_by: label.createdBy,
            })
            .onConflict((oc) =>
              oc.columns(["group_jid", "phone_e164"]).doUpdateSet({
                display_name: label.displayName,
                company_name: label.companyName ?? null,
                created_by: label.createdBy,
              }),
            )
            .execute();
        }
      });
      return db
        .selectFrom("whatsapp_group_member_labels")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .orderBy("display_name", "asc")
        .orderBy("phone_e164", "asc")
        .execute();
    },

    async deleteMemberLabel(groupJid: string, phoneE164: string): Promise<boolean> {
      const normalizedPhone = normalizeContactPointValue("whatsapp", phoneE164);
      const result = await db
        .deleteFrom("whatsapp_group_member_labels")
        .where("group_jid", "=", groupJid)
        .where("phone_e164", "=", normalizedPhone)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },

    async refreshParticipants(
      groupJid: string,
      participants: WhatsAppGroupParticipantInput[],
      lastSeenAt = new Date().toISOString(),
      logger?: WhatsAppGroupParticipantRefreshLogger,
    ): Promise<WhatsAppGroupParticipantRow[]> {
      await db.transaction().execute(async (trx) => {
        if (participants.length === 0) {
          const stored = await trx
            .selectFrom("whatsapp_group_participants")
            .select("participant_jid")
            .where("group_jid", "=", groupJid)
            .execute();
          if (stored.length > 0) {
            logger?.warn(
              { groupJid, storedCount: stored.length, incomingCount: participants.length },
              "Skipped empty WhatsApp group participant refresh",
            );
          }
          return;
        }

        for (const rawParticipant of participants) {
          const participant = normalizedParticipant(rawParticipant);
          const matches =
            participant.phoneE164 || participant.lid
              ? await trx
                  .selectFrom("whatsapp_group_participants")
                  .selectAll()
                  .where("group_jid", "=", groupJid)
                  .where((eb) => {
                    const conditions = [];
                    if (participant.phoneE164) conditions.push(eb("phone_e164", "=", participant.phoneE164));
                    if (participant.lid) conditions.push(eb("lid", "=", participant.lid));
                    return eb.or(conditions);
                  })
                  .execute()
              : [];

          if (!participant.phoneE164 || !participant.lid) {
            if (matches.length > 0) {
              await trx
                .updateTable("whatsapp_group_participants")
                .set({
                  participant_jid: participant.participantJid,
                  admin_role: participant.adminRole,
                  last_seen_at: lastSeenAt,
                })
                .where(
                  "id",
                  "in",
                  matches.map((row) => row.id),
                )
                .where("last_seen_at", "<=", lastSeenAt)
                .execute();
              continue;
            }
          } else {
            const exact = matches.find(
              (row) => row.phone_e164 === participant.phoneE164 && row.lid === participant.lid,
            );
            if (exact) {
              await trx
                .updateTable("whatsapp_group_participants")
                .set({
                  participant_jid: participant.participantJid,
                  admin_role: participant.adminRole,
                  last_seen_at: lastSeenAt,
                })
                .where("id", "=", exact.id)
                .where("last_seen_at", "<=", lastSeenAt)
                .execute();
              continue;
            }
            const phoneOnly = matches.filter((row) => row.phone_e164 === participant.phoneE164 && row.lid === null);
            const lidOnly = matches.filter((row) => row.lid === participant.lid && row.phone_e164 === null);
            if (matches.length === 2 && phoneOnly.length === 1 && lidOnly.length === 1) {
              const freshest = phoneOnly[0].last_seen_at >= lidOnly[0].last_seen_at ? phoneOnly[0] : lidOnly[0];
              const incomingIsFreshest = lastSeenAt >= freshest.last_seen_at;
              const merged = await trx
                .updateTable("whatsapp_group_participants")
                .set({
                  observation_key: whatsappParticipantObservationKey(participant.phoneE164, participant.lid),
                  participant_jid: incomingIsFreshest ? participant.participantJid : freshest.participant_jid,
                  lid: participant.lid,
                  admin_role: incomingIsFreshest ? participant.adminRole : freshest.admin_role,
                  last_seen_at: incomingIsFreshest ? lastSeenAt : freshest.last_seen_at,
                })
                .where("id", "=", phoneOnly[0].id)
                .where("phone_e164", "=", participant.phoneE164)
                .where("lid", "is", null)
                .where("last_seen_at", "=", phoneOnly[0].last_seen_at)
                .executeTakeFirst();
              if (Number(merged.numUpdatedRows) === 1) {
                await trx
                  .deleteFrom("whatsapp_group_participants")
                  .where("id", "=", lidOnly[0].id)
                  .where("phone_e164", "is", null)
                  .where("lid", "=", participant.lid)
                  .where("last_seen_at", "=", lidOnly[0].last_seen_at)
                  .execute();
                continue;
              }
            }
          }

          await trx
            .insertInto("whatsapp_group_participants")
            .values({
              id: randomUUID(),
              group_jid: groupJid,
              observation_key: whatsappParticipantObservationKey(participant.phoneE164, participant.lid),
              participant_jid: participant.participantJid,
              phone_e164: participant.phoneE164,
              lid: participant.lid,
              admin_role: participant.adminRole,
              last_seen_at: lastSeenAt,
            })
            .onConflict((oc) =>
              oc.columns(["group_jid", "observation_key"]).doUpdateSet({
                participant_jid: sql`case when excluded.last_seen_at >= whatsapp_group_participants.last_seen_at then excluded.participant_jid else whatsapp_group_participants.participant_jid end`,
                admin_role: sql`case when excluded.last_seen_at >= whatsapp_group_participants.last_seen_at then excluded.admin_role else whatsapp_group_participants.admin_role end`,
                last_seen_at: sql`case when excluded.last_seen_at >= whatsapp_group_participants.last_seen_at then excluded.last_seen_at else whatsapp_group_participants.last_seen_at end`,
              }),
            )
            .execute();
        }
      });

      return db
        .selectFrom("whatsapp_group_participants")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .orderBy("participant_jid", "asc")
        .execute();
    },

    async listParticipants(groupJid: string): Promise<WhatsAppGroupParticipantRow[]> {
      return db
        .selectFrom("whatsapp_group_participants")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .orderBy("participant_jid", "asc")
        .execute();
    },

    async listJidsByAgent(agentUserId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("whatsapp_groups")
        .select("jid")
        .where("agent_user_id", "=", agentUserId)
        .execute();
      return rows.map((r) => r.jid);
    },

    async listAllAgentBindings(): Promise<Array<{ agentUserId: string; jid: string }>> {
      const rows = await db
        .selectFrom("whatsapp_groups")
        .select(["agent_user_id", "jid"])
        .where("agent_user_id", "is not", null)
        .execute();
      return rows
        .filter((r): r is { agent_user_id: string; jid: string } => r.agent_user_id !== null)
        .map((r) => ({ agentUserId: r.agent_user_id, jid: r.jid }));
    },

    async setAgentForJids(agentUserId: string, jids: string[]): Promise<void> {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("whatsapp_groups")
          .set({ agent_user_id: null })
          .where("agent_user_id", "=", agentUserId)
          .execute();
        if (jids.length === 0) return;
        await trx.updateTable("whatsapp_groups").set({ agent_user_id: agentUserId }).where("jid", "in", jids).execute();
      });
    },
  };
}
