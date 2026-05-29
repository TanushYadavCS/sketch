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
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { isRoleAccountEmail } from "../entities/affiliations";

export interface ParticipantBlockDeps {
  db: Kysely<DB>;
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

/**
 * Normalize a name to a comparable key. Lowercase, collapse whitespace,
 * strip middle initials (one-letter tokens followed by an optional period).
 * Used to match attendee names to action-item owner names across minor
 * formatting variation ("Vedant Parikh" vs "Vedant K. Parikh" vs "vedant
 * parikh").
 */
function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .filter((tok) => !/^[a-z]\.?$/.test(tok))
    .join(" ");
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
  const domainsRepo = createEntityDomainsRepository(deps.db);
  const attendees = (await deps.db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "subject_email"])
    .where("indexed_file_id", "=", opts.fileId)
    .where("fact_type", "=", "attendee")
    .execute()) as AttendeeRow[];

  if (attendees.length === 0) return "";

  const ownerNames = parseActionItemOwners(opts.fileContent);
  const ownerKeys = new Set(ownerNames.map(normalizeNameKey));

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
        if (await domainsRepo.isPersonalOrShared(domain)) continue;
        const company = await domainsRepo.lookupCompanyByDomain(domain);
        if (company) companyLabel = company.name;
      }
    }

    const ownerTag = ownerKeys.has(normalizeNameKey(name)) ? " [action-item owner]" : "";
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
