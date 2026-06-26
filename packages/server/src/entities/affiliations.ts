import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createEntityRepository } from "../db/repositories/entities";
import {
  type EntityDomainsRepository,
  createEntityDomainsRepository,
  proposeCompanyNameFromDomain,
} from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";

export interface AffiliationDeps {
  db: Kysely<DB>;
  domainsRepo: EntityDomainsRepository;
  logger?: Logger;
}

export interface InferAffiliationInput {
  personEntityId: string;
  email: string | null | undefined;
  evidenceFileId?: string | null;
  firstObservedByUserId?: string | null;
}

/**
 * Role-account local-parts: shared mailboxes, not real people. A single
 * `hello@stripe.com` notification email should NOT promote Stripe as a
 * company someone "works at". Personal-domain seeds already block gmail/
 * outlook/etc.; this list catches the orthogonal corporate-side noise.
 *
 * Conservative on purpose. Adding too many entries here starts dropping
 * real people whose work email happens to be `sales@foo.com` (some
 * founders / one-person startups do this). Kept to obvious shared
 * mailboxes only.
 */
const ROLE_ACCOUNT_LOCAL_PARTS = new Set([
  "admin",
  "billing",
  "contact",
  "help",
  "hello",
  "hr",
  "info",
  "mail",
  "noreply",
  "no-reply",
  "notifications",
  "office",
  "ops",
  "press",
  "privacy",
  "security",
  "support",
  "team",
]);

export function isRoleAccountEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  if (ROLE_ACCOUNT_LOCAL_PARTS.has(local)) return true;
  // Catch variants with separators: "sales-team@", "support.us@".
  const head = local.split(/[.\-_+]/)[0] ?? local;
  return ROLE_ACCOUNT_LOCAL_PARTS.has(head);
}

export function isProviderManagedEmailDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase();
  return normalized === "calendar.google.com" || normalized.endsWith(".calendar.google.com");
}

/**
 * Derive a `works_at` edge (or a structured domain-observation candidate) from
 * a person entity's email domain. Idempotent under the repo's UNIQUE keys.
 *
 * Personal/shared seed domains (gmail.com, slack.com, …) short-circuit
 * before either side-effect — they're the load-bearing guard that keeps the
 * graph from declaring 57 people work at gmail.com.
 *
 * Caller responsibility: only invoke after the person entity is confirmed
 * (not when materializePersonFact queues a review). The review-resolve path
 * is responsible for calling this when it confirms the entity and attaches
 * the held email.
 */
export async function inferAffiliationFromEmail(deps: AffiliationDeps, input: InferAffiliationInput): Promise<void> {
  const rawEmail = input.email ?? null;
  if (!rawEmail) return;
  const domain = deps.domainsRepo.normalizeEmailDomain(rawEmail);
  if (!domain) return;
  if (isProviderManagedEmailDomain(domain)) return;
  if (await deps.domainsRepo.isPersonalOrShared(domain)) return;
  // Role-account local-parts (hello@, info@, support@, …) are shared
  // mailboxes, not people. Skip both works_at inference and candidate
  // accumulation — a notification email isn't evidence of employment.
  if (isRoleAccountEmail(rawEmail)) return;

  const company = await deps.domainsRepo.lookupCompanyByDomain(domain);
  if (company) {
    const relationshipId = await deps.domainsRepo.upsertWorksAt({
      personEntityId: input.personEntityId,
      companyEntityId: company.id,
      confidence: "INFERRED",
      confidenceScore: 0.9,
      source: "email_domain",
    });
    if (input.evidenceFileId) {
      await deps.domainsRepo.addEvidence({
        relationshipId,
        indexedFileId: input.evidenceFileId,
        note: `email_domain:${domain}`,
      });
      // Mention timeline: surface the company on the same file the person
      // appears in. UI reads entity_mentions, not entity_relationships, so
      // without this an inferred company looks empty in the drawer.
      const entityRepo = createEntityRepository(deps.db);
      await entityRepo.createMention({
        entityId: company.id,
        indexedFileId: input.evidenceFileId,
        confidence: "INFERRED",
        source: "email_domain",
        relation: "mentioned",
      });
    }
    return;
  }

  // No company entity yet — accumulate a structured candidate, but only when
  // we have file provenance. Without `evidenceFileId`, `first_seen_file_id`'s
  // NOT NULL constraint would force us to invent a synthetic file or weaken
  // the schema, and this PR deliberately does neither.
  if (!input.evidenceFileId) return;
  await deps.domainsRepo.upsertDomainObservation({
    domain,
    proposedCompanyName: proposeCompanyNameFromDomain(domain),
    observedPersonEntityId: input.personEntityId,
    evidenceFileId: input.evidenceFileId,
    firstObservedByUserId: input.firstObservedByUserId ?? null,
  });
}

export function buildAffiliationDeps(db: Kysely<DB>, logger?: Logger): AffiliationDeps {
  return { db, domainsRepo: createEntityDomainsRepository(db), logger };
}
