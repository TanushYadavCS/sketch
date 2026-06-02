/**
 * Deterministic engagement floor.
 *
 * After LLM extraction, this guarantees a minimum `engaged_with` recall for
 * the cross-domain meeting shape that the LLM systematically under-emits.
 *
 * Why this exists: in the OW <> Canvas standup corpus, the meeting body
 * (summary + action items) names projects and people but never the external
 * company. The LLM correctly extracts `Vedant works_on Aviation Edge` but
 * has no textual basis to assert `Vedant engaged_with Oliver Wyman`. The
 * attendee list is the only proof of cross-company engagement, and it
 * lives in `indexed_file_facts` — outside the LLM prompt.
 *
 * Algorithm (deterministic, no LLM):
 *   1. Resolve each attendee → company via corporate email domain (drops
 *      personal/shared/role-account emails).
 *   2. Parse `## Action Items` from the markdown body (Fireflies shape).
 *   3. For every action-item owner who is also an attendee with a resolved
 *      company, emit an `engaged_with` fact to every OTHER company present
 *      in the same meeting (symmetric across the cross-company shape — we
 *      do not require a notion of "home" vs "external", which sketch has
 *      no global config for).
 *
 * Facts are written with `source = "attendee_action_item"` so they are
 * auditable distinct from LLM-emitted facts. They flow through the same
 * `materializeLlmRelationFact` pipeline (factType = "llm_relation") so
 * direction guards, confidence gates, and the `entity_relationships`
 * unique constraint all apply unchanged.
 *
 * Idempotent: `subjectSourceId` is keyed off (fileId, ownerName, companyName)
 * so reruns upsert in place without duplicating facts. No LLM prompt version
 * in the key — these facts survive prompt bumps because they are not LLM
 * output and don't carry the LLM's stale-output risk.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import {
  type UpsertIndexedFileFactInput,
  buildIndexedFileFactKey,
  createIndexedFileFactRepository,
} from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { isRoleAccountEmail } from "../entities/affiliations";
import { cleanupEmptyRelationships, cleanupRelationshipEvidenceForFacts } from "../entities/materialize";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { yieldToEventLoop } from "../lib/event-loop";
import { parseActionItemOwners } from "./participant-block";

export interface EngagementFloorDeps {
  db: Kysely<DB>;
  logger?: Logger;
}

export interface ApplyEngagementFloorOptions {
  fileId: string;
  fileContent: string;
  connectorConfigId: string;
  contentHash: string | null;
}

export interface EngagementFloorResult {
  /** Number of `engaged_with` facts upserted by this pass. */
  emitted: number;
  /** Number of previously emitted facts tombstoned because this pass no longer supports them. */
  tombstoned: number;
}

export interface FloorRetryForDomainsResult {
  domains: number;
  filesScanned: number;
  emitted: number;
  cappedDomains: number;
}

interface ResolvedAttendee {
  name: string;
  companyName: string;
  companyId: string;
}

function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .filter((tok) => !/^[a-z]\.?$/.test(tok))
    .join(" ");
}

async function reconcileAttendeeActionFacts(
  deps: EngagementFloorDeps,
  fileId: string,
  emittedFactKeys: Set<string>,
): Promise<number> {
  const factRepo = createIndexedFileFactRepository(deps.db);
  const reconcile = await factRepo.reconcileStaleFacts(
    { kind: "file", indexedFileId: fileId, source: "attendee_action_item", factType: "llm_relation" },
    emittedFactKeys,
  );
  if (reconcile.tombstonedFactIds.length > 0) {
    await cleanupRelationshipEvidenceForFacts(deps.db, reconcile.tombstonedFactIds);
    await cleanupEmptyRelationships(deps.db);
  }
  return reconcile.tombstoned;
}

export async function applyEngagementFloor(
  deps: EngagementFloorDeps,
  opts: ApplyEngagementFloorOptions,
): Promise<EngagementFloorResult> {
  const domainsRepo = createEntityDomainsRepository(deps.db);
  const factsRepo = createIndexedFileFactRepository(deps.db);
  const emittedFactKeys = new Set<string>();
  const finish = async (emitted: number): Promise<EngagementFloorResult> => ({
    emitted,
    tombstoned: await reconcileAttendeeActionFacts(deps, opts.fileId, emittedFactKeys),
  });

  const owner = await deps.db
    .selectFrom("connector_configs")
    .select("created_by")
    .where("id", "=", opts.connectorConfigId)
    .executeTakeFirst();
  const ownerUserId = owner?.created_by ?? null;

  const attendees = await deps.db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "subject_email"])
    .where("indexed_file_id", "=", opts.fileId)
    .where("fact_type", "=", "attendee")
    .execute();

  if (attendees.length === 0) return finish(0);

  const resolved: ResolvedAttendee[] = [];
  const seen = new Set<string>();
  for (const row of attendees) {
    const name = row.subject_name?.trim();
    const email = row.subject_email?.trim();
    if (!name || !email) continue;
    if (isRoleAccountEmail(email)) continue;
    const domain = domainsRepo.normalizeEmailDomain(email);
    if (!domain) continue;
    if (await domainsRepo.isPersonalOrShared(domain)) continue;
    const company = await domainsRepo.lookupCompanyByDomain(domain);
    if (!company) continue;
    const dedupKey = `${name.toLowerCase()}|${company.id}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    resolved.push({ name, companyName: company.name, companyId: company.id });
  }

  if (resolved.length === 0) return finish(0);

  const companyIds = new Set(resolved.map((r) => r.companyId));
  if (companyIds.size < 2) return finish(0);

  const ownerNames = parseActionItemOwners(opts.fileContent);
  if (ownerNames.length === 0) return finish(0);
  const ownerKeys = new Set(ownerNames.map(normalizeNameKey));

  const owners = resolved.filter((r) => ownerKeys.has(normalizeNameKey(r.name)));
  if (owners.length === 0) return finish(0);

  const uniqueCompanies = Array.from(
    new Map(resolved.map((r) => [r.companyId, { companyId: r.companyId, companyName: r.companyName }])).values(),
  );

  let emitted = 0;
  for (const owner of owners) {
    for (const target of uniqueCompanies) {
      if (target.companyId === owner.companyId) continue;
      const input: UpsertIndexedFileFactInput = {
        indexedFileId: opts.fileId,
        connectorConfigId: opts.connectorConfigId,
        createdByUserId: ownerUserId,
        contentHash: opts.contentHash,
        source: "attendee_action_item",
        factType: "llm_relation",
        relation: "engaged_with",
        subjectName: owner.name,
        subjectSource: "attendee_action_item",
        subjectSourceId: `${opts.fileId}:attendee_action_item:engaged_with:${owner.name}:${target.companyName}`,
        contextSnippet: `Action-item owner ${owner.name} attended this meeting alongside attendees from ${target.companyName}.`,
        raw: {
          contentHash: opts.contentHash ?? `missing-content-hash:${opts.fileId}`,
          promptVersion: "attendee-action-item-v1",
          model: "deterministic-attendee-action-item",
          relationType: "engaged_with",
          confidence: 0.9,
          sourceConfidence: 1,
          targetConfidence: 1,
          context: `${owner.name} owns action items in a meeting with ${target.companyName} attendees`,
          source: { name: owner.name, type: "person", variations: [] },
          target: { name: target.companyName, type: "company", variations: [] },
        },
      };
      emittedFactKeys.add(buildIndexedFileFactKey(input));
      await factsRepo.upsertFact(input);
      emitted += 1;
      await yieldToEventLoop();
    }
  }

  if (emitted > 0 && deps.logger) {
    deps.logger.info(
      { fileId: opts.fileId, emitted, owners: owners.length, companies: companyIds.size },
      "engagement-floor: emitted engaged_with facts from attendee + action-item signal",
    );
  }

  return finish(emitted);
}

export async function floorRetryForDomains(
  deps: EngagementFloorDeps,
  domains: string[],
  opts?: { maxFilesPerDomain?: number; materialize?: boolean; fileIds?: string[] },
): Promise<FloorRetryForDomainsResult> {
  const domainsRepo = createEntityDomainsRepository(deps.db);
  const maxFilesPerDomain = opts?.maxFilesPerDomain ?? 5000;
  const normalizedDomains = Array.from(new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean)));
  const scopedFileIds = opts?.fileIds ? Array.from(new Set(opts.fileIds.filter(Boolean))) : null;
  const result: FloorRetryForDomainsResult = {
    domains: normalizedDomains.length,
    filesScanned: 0,
    emitted: 0,
    cappedDomains: 0,
  };
  if (normalizedDomains.length === 0) return result;
  if (scopedFileIds?.length === 0) return result;

  for (const domain of normalizedDomains) {
    const attendeeRows = await deps.db
      .selectFrom("indexed_file_facts")
      .select(["indexed_file_id", "subject_email"])
      .where("fact_type", "=", "attendee")
      .where("subject_email", "is not", null)
      .$if(scopedFileIds !== null, (qb) => qb.where("indexed_file_id", "in", scopedFileIds ?? []))
      .where("deleted_at", "is", null)
      .execute();

    const fileIds: string[] = [];
    const seen = new Set<string>();
    for (const row of attendeeRows) {
      if (!row.indexed_file_id) continue;
      if (!row.subject_email) continue;
      if (domainsRepo.normalizeEmailDomain(row.subject_email) !== domain) continue;
      if (seen.has(row.indexed_file_id)) continue;
      seen.add(row.indexed_file_id);
      fileIds.push(row.indexed_file_id);
      if (fileIds.length >= maxFilesPerDomain) break;
    }
    if (fileIds.length >= maxFilesPerDomain) result.cappedDomains += 1;

    if (fileIds.length === 0) continue;
    const files = await deps.db
      .selectFrom("indexed_files")
      .select(["id", "connector_config_id", "content", "content_hash"])
      .where("id", "in", fileIds)
      .where("is_archived", "=", 0)
      .execute();
    for (const file of files) {
      if (!file.content) continue;
      result.filesScanned += 1;
      const floor = await applyEngagementFloor(deps, {
        fileId: file.id,
        fileContent: file.content,
        connectorConfigId: file.connector_config_id,
        contentHash: file.content_hash,
      });
      result.emitted += floor.emitted;
    }
  }

  if (result.emitted > 0 && opts?.materialize !== false && deps.logger) {
    await materializeUnmaterializedFacts(deps.db, deps.logger);
  }

  deps.logger?.info(result, "engagement-floor: domain retry complete");
  return result;
}
