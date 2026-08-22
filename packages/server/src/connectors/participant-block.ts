/**
 * Meeting Participants block.
 *
 * Renders a structured markdown block of attendees with their resolved
 * company affiliations, prepended to the LLM extraction prompt body. This
 * gives the model the cross-company signal that lives only in attendee
 * metadata — never in the meeting summary text itself.
 *
 * Action-item owners are flagged separately: silent attendees do not imply
 * an engagement; people who own action items in this meeting are real
 * delivery evidence.
 *
 * Resolution path:
 *   - Attendees come from `indexed_file_facts` (`fact_type = "attendee"`).
 *   - Email domain → corporate company entity (reuses entity_domains).
 *   - Personal / shared / role accounts are dropped.
 *   - Cross-domain attendees without a resolved company render as
 *     "external (no resolved company)" — the LLM still sees the cross-domain
 *     signal without us confidently asserting an edge endpoint.
 *
 * `parseActionItemOwners` is exported so the deterministic engagement floor
 * can reuse the same parser.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { PERSON_PARTICIPANT_FACT_TYPES } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { isRoleAccountEmail } from "../entities/affiliations";
import { normalizeParticipantNameKey } from "../entities/name-keys";
import { buildWhatsAppRosterSnapshot, stableWhatsAppParticipantJidRef } from "../whatsapp/identity-resolution";
import { WHATSAPP_CONVERSATION_SLICE_FILE_TYPE } from "./types";

export interface ParticipantBlockDeps {
  db: Kysely<DB>;
  logger: Logger;
}

interface AttendeeRow {
  subject_name: string | null;
  subject_email: string | null;
}

/**
 * Parse owner names from a Fireflies-style markdown body.
 *
 * Format observed:
 *   ## Action Items
 *   -
 *   **Vedant Parikh**
 *   Description (timestamp)
 *
 *   **Ohoud Zitan**
 *   Description (timestamp)
 *
 * Returns the unique trimmed names that appear as bold headers inside the
 * Action Items section. Non-Fireflies markdown (missing heading, different
 * structure) returns []; callers degrade to "no action-item owners".
 */
export function parseActionItemOwners(content: string): string[] {
  if (!content) return [];
  const headingMatch = content.match(/##\s*Action\s+Items\s*\n/i);
  if (!headingMatch) return [];
  const start = (headingMatch.index ?? 0) + headingMatch[0].length;
  const tail = content.slice(start);
  const nextHeadingIdx = tail.search(/\n##\s+/);
  const section = nextHeadingIdx === -1 ? tail : tail.slice(0, nextHeadingIdx);

  const owners = new Set<string>();
  const ownerRe = /^\s*\*\*([^*\n]+)\*\*\s*$/gm;
  for (let m = ownerRe.exec(section); m !== null; m = ownerRe.exec(section)) {
    const name = m[1].trim();
    if (name.length > 0) owners.add(name);
  }
  return Array.from(owners);
}

export interface BuildParticipantBlockOptions {
  fileId: string;
  fileContent: string;
}

/**
 * Build the markdown block to prepend to the extraction prompt. Returns
 * an empty string when there are no attendee facts, no resolved domains,
 * or only role/personal accounts — caller can prepend unconditionally.
 */
export async function buildParticipantBlock(
  deps: ParticipantBlockDeps,
  opts: BuildParticipantBlockOptions,
): Promise<string> {
  const whatsAppBlock = await buildWhatsAppSpeakerBlock(deps, opts.fileId);
  if (whatsAppBlock !== null) return whatsAppBlock;
  const domainsRepo = createEntityDomainsRepository(deps.db);
  const attendees = (await deps.db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "subject_email"])
    .where("indexed_file_id", "=", opts.fileId)
    .where("fact_type", "in", PERSON_PARTICIPANT_FACT_TYPES)
    .execute()) as AttendeeRow[];

  if (attendees.length === 0) return "";

  const ownerNames = parseActionItemOwners(opts.fileContent);
  const ownerKeys = new Set(ownerNames.map(normalizeParticipantNameKey));

  type Rendered = { line: string; sortKey: string };
  const seen = new Set<string>();
  const rendered: Rendered[] = [];
  for (const att of attendees) {
    const name = att.subject_name?.trim();
    const email = att.subject_email?.trim() ?? "";
    if (!name) continue;
    const dedupKey = `${name.toLowerCase()}|${email.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    let companyLabel = "external (no resolved company)";
    if (email) {
      if (isRoleAccountEmail(email)) continue;
      const domain = domainsRepo.normalizeEmailDomain(email);
      if (domain) {
        if (!(await domainsRepo.isPersonalOrShared(domain))) {
          const company = await domainsRepo.lookupCompanyByDomain(domain);
          if (company) companyLabel = company.name;
        }
      }
    }

    const ownerTag = ownerKeys.has(normalizeParticipantNameKey(name)) ? " [action-item owner]" : "";
    const emailPart = email ? ` (${email})` : "";
    rendered.push({
      line: `- ${name} — ${companyLabel}${emailPart}${ownerTag}`,
      sortKey: name.toLowerCase(),
    });
  }

  if (rendered.length === 0) return "";

  rendered.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return `\n## Meeting participants\n${rendered.map((r) => r.line).join("\n")}\n`;
}

/**
 * WhatsApp chunk files derive their participants from the slice at
 * prompt-build time instead of stored attendee facts: only the people who
 * actually spoke in the chunk, each with whatever identity we hold — curated
 * label (and company), phone, and the linked teammate email. Derived live so
 * the open chunk's block is always current, and kept out of the file body so
 * identifiers never enter embeddings (ruling 2026-08-12). Returns null for
 * non-WhatsApp files so the attendee-fact path runs unchanged.
 */
async function buildWhatsAppSpeakerBlock(deps: ParticipantBlockDeps, fileId: string): Promise<string | null> {
  const file = await deps.db
    .selectFrom("indexed_files")
    .select(["file_type"])
    .where("id", "=", fileId)
    .executeTakeFirst();
  if (file?.file_type !== WHATSAPP_CONVERSATION_SLICE_FILE_TYPE) return null;

  const slice = await deps.db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .select([
      "conversation_slices.conversation_id as conversation_id",
      "conversation_slices.first_message_id as first_message_id",
      "conversation_slices.last_message_id as last_message_id",
      "conversation_slices.denoised_message_ids as denoised_message_ids",
      "conversations.provider_conversation_id as group_jid",
    ])
    .where("conversation_slices.indexed_file_id", "=", fileId)
    .executeTakeFirst();
  if (!slice) return "";

  let denoisedIds: number[] | null = null;
  if (slice.denoised_message_ids) {
    try {
      const parsed = JSON.parse(slice.denoised_message_ids) as unknown;
      if (Array.isArray(parsed)) denoisedIds = parsed.filter((id): id is number => Number.isInteger(id));
    } catch {
      denoisedIds = null;
    }
  }
  let senderQuery = deps.db
    .selectFrom("conversation_messages")
    .select(["sender_jid"])
    .where("conversation_id", "=", slice.conversation_id)
    .where("sender_jid", "is not", null);
  senderQuery =
    denoisedIds && denoisedIds.length > 0
      ? senderQuery.where("id", "in", denoisedIds)
      : senderQuery.where("id", ">=", slice.first_message_id).where("id", "<=", slice.last_message_id);
  const senders = await senderQuery.execute();
  const speakerRefs = new Set(
    senders
      .map((row) => row.sender_jid)
      .filter((jid): jid is string => Boolean(jid))
      .map((jid) => stableWhatsAppParticipantJidRef(jid)),
  );
  if (speakerRefs.size === 0) return "";

  const roster = await buildWhatsAppRosterSnapshot({
    db: deps.db,
    groupJid: slice.group_jid,
    conversationId: slice.conversation_id,
    logger: deps.logger,
  });
  const speakers = roster.snapshot.participants.filter(
    (participant) =>
      speakerRefs.has(participant.participantJidRef) || participant.senderJidRefs.some((ref) => speakerRefs.has(ref)),
  );
  if (speakers.length === 0) return "";

  const participantRows = await deps.db
    .selectFrom("whatsapp_group_participants")
    .select(["participant_jid", "phone_e164"])
    .where("group_jid", "=", slice.group_jid)
    .execute();
  const phoneByRef = new Map(
    participantRows.map((row) => [stableWhatsAppParticipantJidRef(row.participant_jid), row.phone_e164]),
  );
  const userIds = speakers.map((speaker) => speaker.userId).filter((id): id is string => Boolean(id));
  const users =
    userIds.length > 0
      ? await deps.db.selectFrom("users").select(["id", "email"]).where("id", "in", userIds).execute()
      : [];
  const emailByUserId = new Map(users.map((user) => [user.id, user.email]));

  const lines = speakers
    .map((speaker) => {
      const parts = [speaker.company ? `${speaker.displayName} (${speaker.company})` : speaker.displayName];
      const phone = phoneByRef.get(speaker.participantJidRef);
      if (phone) parts.push(phone);
      const email = speaker.userId ? emailByUserId.get(speaker.userId) : null;
      if (email) parts.push(email);
      return `- ${parts.join(" · ")}`;
    })
    .sort((a, b) => a.localeCompare(b));
  return `\n## Conversation participants (spoke in this chunk)\n${lines.join("\n")}\n`;
}
