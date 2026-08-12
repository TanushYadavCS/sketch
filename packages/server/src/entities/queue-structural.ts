import type { Kysely } from "kysely";
import { normalizeName } from "../connectors/name-normalize";
import type { DB } from "../db/schema";
import { readPersonEmailFromMetadata } from "./materialize-json";
import type { PassReason, ReasonHit } from "./queue-projection";
import { type LiveEntity, type QueueRowForPasses, nameKey } from "./queue-reconcile";

type EntityFacts = { id: string; name: string; source_type: string; metadata: string | null };

export type StructuralResult = { hits: ReasonHit[] };

function cleanEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function isSingleToken(name: string): boolean {
  return name.trim().split(/\s+/).filter(Boolean).length === 1;
}

function disjoint(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return false;
  return true;
}

async function loadEntities(db: Kysely<DB>, ids: string[]): Promise<Map<string, EntityFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "metadata"])
    .where("id", "in", ids)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Email addresses per entity, unioned from the two stores an entity keeps them
 * in. Parsing happens here rather than in SQL: `metadata` is a JSON string and
 * the two dialects disagree about how to read into it, so a SQL-side extraction
 * would produce different veto sets on SQLite and Postgres.
 */
async function loadEntityEmails(db: Kysely<DB>, entities: Map<string, EntityFacts>): Promise<Map<string, Set<string>>> {
  const byEntity = new Map<string, Set<string>>();
  for (const entity of entities.values()) {
    const email = cleanEmail(readPersonEmailFromMetadata(entity.metadata));
    byEntity.set(entity.id, new Set(email ? [email] : []));
  }

  const ids = Array.from(entities.keys());
  if (ids.length === 0) return byEntity;

  const points = await db
    .selectFrom("entity_contact_points")
    .select(["entity_id", "value"])
    .where("entity_id", "in", ids)
    .where("kind", "=", "email")
    .execute();
  for (const point of points) {
    const email = cleanEmail(point.value);
    if (!email) continue;
    const held = byEntity.get(point.entity_id);
    if (held) held.add(email);
  }
  return byEntity;
}

async function loadEvidenceFiles(db: Kysely<DB>, reviewIds: string[]): Promise<Map<string, string[]>> {
  if (reviewIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_review_evidence")
    .select(["review_id", "indexed_file_id"])
    .where("review_id", "in", reviewIds)
    .distinct()
    .execute();
  const byReview = new Map<string, string[]>();
  for (const row of rows) {
    const held = byReview.get(row.review_id) ?? [];
    held.push(row.indexed_file_id);
    byReview.set(row.review_id, held);
  }
  return byReview;
}

/**
 * Files each candidate is mentioned in, counted as distinct files. The unique
 * index on `entity_mentions` is (entity_id, indexed_file_id, relation), so
 * counting mention rows would count one file once per relation.
 */
async function loadMentionFiles(db: Kysely<DB>, entityIds: string[]): Promise<Map<string, Set<string>>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_mentions")
    .select(["entity_id", "indexed_file_id"])
    .where("entity_id", "in", entityIds)
    .distinct()
    .execute();
  const byEntity = new Map<string, Set<string>>();
  for (const row of rows) {
    const held = byEntity.get(row.entity_id) ?? new Set<string>();
    held.add(row.indexed_file_id);
    byEntity.set(row.entity_id, held);
  }
  return byEntity;
}

type AttendeeFact = { id: string; indexed_file_id: string; email: string | null; normalized: string | null };

async function loadAttendeeFacts(db: Kysely<DB>, fileIds: string[]): Promise<Map<string, AttendeeFact[]>> {
  if (fileIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["id", "indexed_file_id", "subject_email", "normalized_subject_name"])
    .where("indexed_file_id", "in", fileIds)
    .where("fact_type", "=", "attendee")
    .where("deleted_at", "is", null)
    .execute();
  const byFile = new Map<string, AttendeeFact[]>();
  for (const row of rows) {
    if (!row.indexed_file_id) continue;
    const held = byFile.get(row.indexed_file_id) ?? [];
    held.push({
      id: row.id,
      indexed_file_id: row.indexed_file_id,
      email: cleanEmail(row.subject_email),
      normalized: row.normalized_subject_name,
    });
    byFile.set(row.indexed_file_id, held);
  }
  return byFile;
}

type Side = { emails: Set<string>; normalized: string };

/**
 * The name branch is disabled when the two sides normalise identically:
 * then a name cannot tell them apart, and B2 would claim two people from one
 * person's two addresses.
 */
function factMatches(fact: AttendeeFact, side: Side, allowNameMatch: boolean): boolean {
  if (fact.email && side.emails.has(fact.email)) return true;
  return allowNameMatch && fact.normalized !== null && fact.normalized === side.normalized;
}

/**
 * Folding the candidate's own emails onto the proposal side makes the two
 * sides overlap, so the `different_emails` veto can never fire. Removing this
 * guard silently reintroduces that bug: the rule keeps returning an answer,
 * just the wrong lower-certainty one.
 */
function shouldFoldProposalEntityEmails(
  proposalEntity: LiveEntity | null,
  candidateId: string,
): proposalEntity is LiveEntity {
  return proposalEntity !== null && proposalEntity.id !== candidateId;
}

/**
 * Two attendees on one file, with different fact ids and different emails, one
 * matching each side of the pair — the file says they are two people.
 *
 * Built from `indexed_file_facts` on both sides because `entity_mentions` has no
 * column linking a mention back to the fact that produced it.
 */
function coListed(facts: AttendeeFact[], proposal: Side, candidate: Side): boolean {
  const namesDistinguish = proposal.normalized !== candidate.normalized;
  for (const left of facts) {
    if (!factMatches(left, proposal, namesDistinguish)) continue;
    for (const right of facts) {
      if (right.id === left.id) continue;
      if (!factMatches(right, candidate, namesDistinguish)) continue;
      if (left.email && right.email && left.email !== right.email) return true;
    }
  }
  return false;
}

/**
 * Phase B — structure answers it.
 *
 * Same scope and same projection as phase A, and it writes nothing to the graph
 * either. Vetoes (B1–B3) are certain and outrank blocks (B4, B5), which say only
 * that there is not enough evidence to merge.
 */
export async function structuralPass(
  db: Kysely<DB>,
  rows: QueueRowForPasses[],
  byName: Map<string, LiveEntity>,
): Promise<StructuralResult> {
  const withCandidate = rows.filter((row) => row.candidate_entity_id !== null);
  if (withCandidate.length === 0) return { hits: [] };

  const candidateIds = Array.from(
    new Set(withCandidate.map((row) => row.candidate_entity_id).filter((id): id is string => id !== null)),
  );
  const proposalEntityIds = Array.from(
    new Set(
      withCandidate
        .map((row) => byName.get(nameKey(row.entity_type, row.proposed_name))?.id)
        .filter((id): id is string => id !== undefined),
    ),
  );

  const entities = await loadEntities(db, Array.from(new Set([...candidateIds, ...proposalEntityIds])));
  const [emails, evidence, mentions] = await Promise.all([
    loadEntityEmails(db, entities),
    loadEvidenceFiles(
      db,
      withCandidate.map((row) => row.id),
    ),
    loadMentionFiles(db, candidateIds),
  ]);

  const evidenceFileIds = Array.from(new Set(Array.from(evidence.values()).flat()));
  const attendees = await loadAttendeeFacts(db, evidenceFileIds);

  const hits: ReasonHit[] = [];

  for (const row of withCandidate) {
    const candidateId = row.candidate_entity_id;
    if (candidateId === null) continue;
    const candidate = entities.get(candidateId);
    if (!candidate) continue;

    const proposalEntity = byName.get(nameKey(row.entity_type, row.proposed_name)) ?? null;
    const proposalEmails = new Set<string>();
    const proposedEmail = cleanEmail(row.proposed_email);
    if (proposedEmail) proposalEmails.add(proposedEmail);
    if (shouldFoldProposalEntityEmails(proposalEntity, candidateId)) {
      for (const email of emails.get(proposalEntity.id) ?? []) proposalEmails.add(email);
    }
    const candidateEmails = emails.get(candidateId) ?? new Set<string>();

    const proposalSide: Side = { emails: proposalEmails, normalized: normalizeName(row.proposed_name) };
    const candidateSide: Side = { emails: candidateEmails, normalized: normalizeName(candidate.name) };

    const push = (reason: PassReason): void => {
      hits.push({ rowId: row.id, reason });
    };

    if (proposalEmails.size > 0 && candidateEmails.size > 0 && disjoint(proposalEmails, candidateEmails)) {
      push("different_emails");
    }

    if (row.entity_type !== candidate.source_type) push("type_mismatch");

    const files = evidence.get(row.id) ?? [];
    if (files.some((fileId) => coListed(attendees.get(fileId) ?? [], proposalSide, candidateSide))) {
      push("co_listed_participants");
    }

    const candidateFiles = mentions.get(candidateId) ?? new Set<string>();
    if (!files.some((fileId) => candidateFiles.has(fileId))) push("no_shared_file");

    if (
      isSingleToken(row.proposed_name) &&
      isSingleToken(candidate.name) &&
      proposalEmails.size === 0 &&
      candidateEmails.size === 0
    ) {
      push("bare_name_only");
    }
  }

  return { hits };
}
