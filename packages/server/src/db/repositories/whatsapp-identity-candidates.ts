import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { DB, WhatsAppIdentityCandidatesTable } from "../schema";

export type WhatsAppIdentityCandidateRow = Selectable<WhatsAppIdentityCandidatesTable>;

export interface WhatsAppIdentityCandidateObservation {
  groupJid: string;
  candidateRef: string;
  participantJidRef: string;
  displayName?: string | null;
  sliceId: string;
  seenAt: string;
}

export function createWhatsAppIdentityCandidateRepository(db: Kysely<DB>) {
  return {
    async recordObservation(input: WhatsAppIdentityCandidateObservation): Promise<WhatsAppIdentityCandidateRow> {
      const now = new Date().toISOString();
      await db
        .insertInto("whatsapp_identity_candidates")
        .values({
          group_jid: input.groupJid,
          candidate_ref: input.candidateRef,
          participant_jid_ref: input.participantJidRef,
          display_name: input.displayName ?? null,
          kept_slice_count: 1,
          first_seen_at: input.seenAt,
          last_seen_at: input.seenAt,
          last_slice_id: input.sliceId,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["group_jid", "candidate_ref"]).doUpdateSet({
            participant_jid_ref: input.participantJidRef,
            display_name: input.displayName ?? null,
            kept_slice_count: sql<number>`${sql.ref("whatsapp_identity_candidates.kept_slice_count")} + 1`,
            last_seen_at: input.seenAt,
            last_slice_id: input.sliceId,
            updated_at: now,
          }),
        )
        .execute();

      return db
        .selectFrom("whatsapp_identity_candidates")
        .selectAll()
        .where("group_jid", "=", input.groupJid)
        .where("candidate_ref", "=", input.candidateRef)
        .executeTakeFirstOrThrow();
    },
  };
}
