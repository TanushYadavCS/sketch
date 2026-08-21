/**
 * Shared seeding helpers for the project-minting integration suites. Split
 * out of the acceptance suite so the legacy (engagement-era) and v2
 * (recursive-projects) suites exercise identical corpora without importing
 * each other's describe blocks.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { createApp } from "../http";
import type { GeminiGenerator } from "./gemini-generate";
import type { ClusterVerdict } from "./project-minting";

export const FIXTURE_PASSWORD = "testpassword123";

export async function loadEntities(db: Kysely<DB>, ids: string[]) {
  return db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "status", "deleted_at", "merged_into_entity_id"])
    .where("id", "in", ids)
    .orderBy("id", "asc")
    .execute();
}

export async function seedConnector(db: Kysely<DB>): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connector_configs")
    .values({ id, connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "test" })
    .execute();
  return id;
}

export async function seedCompany(db: Kysely<DB>, name: string, domain: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "company",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
      share_with_everyone: 1,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  await db
    .insertInto("entity_domains")
    .values({
      id: randomUUID(),
      entity_id: id,
      domain,
      kind: "corporate",
      is_primary: 1,
      confidence: 1,
      source: "test",
    })
    .execute();
  return id;
}

export async function seedFile(
  db: Kysely<DB>,
  connectorId: string,
  opts: { fileName: string; source: string; date: string; content: string },
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: connectorId,
      provider_file_id: id,
      provider_url: null,
      file_name: opts.fileName,
      file_type: "transcript",
      content_category: "document",
      content: opts.content,
      summary: null,
      source: opts.source,
      source_path: null,
      content_hash: id,
      source_created_at: opts.date,
      source_updated_at: null,
      synced_at: opts.date,
      context_note: null,
      access_scope_id: null,
    })
    .execute();
  return id;
}

export async function seedAttendee(
  db: Kysely<DB>,
  connectorId: string,
  fileId: string,
  name: string,
  email: string,
  factType: "attendee" | "correspondent" = "attendee",
) {
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: randomUUID(),
      indexed_file_id: fileId,
      connector_config_id: connectorId,
      created_by_user_id: null,
      source: "test",
      fact_type: factType,
      relation: factType === "attendee" ? "attended" : "corresponded",
      subject_name: name,
      subject_email: email,
      subject_source: null,
      subject_source_id: null,
      context_snippet: null,
      raw: null,
      fact_key: `${fileId}:${factType}:${email}`,
      last_seen_sync_run_id: null,
      deleted_at: null,
      content_hash: null,
      materialization_input_hash: null,
      normalized_subject_name: null,
      normalized_mention_name: null,
      raw_mention_type: null,
      mention_type: null,
      feature_corroboration_key: null,
      normalization_projected_at: null,
      materialized_at: null,
    })
    .execute();
}

export async function seedProjectFragment(db: Kysely<DB>, name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
      share_with_everyone: 1,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  return id;
}

export async function seedMention(db: Kysely<DB>, entityId: string, fileId: string): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      indexed_file_id: fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

export async function seedTaskWithFileEvidence(db: Kysely<DB>, id: string, fileId: string) {
  await db
    .insertInto("tasks")
    .values({
      id,
      parent_entity_id: null,
      parent_source_ref: null,
      parent_name: null,
      source: "test",
      external_ref: null,
      title: id,
      normalized_title: id,
      status: "open",
      status_raw: null,
      status_authority: "local",
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: null,
      priority: null,
      due_at: null,
      provenance: "llm",
      source_task_id: id,
      created_by_user_id: null,
      status_changed_at: null,
      completed_at: null,
      valid_from: null,
      valid_to: null,
    })
    .execute();
  await db.insertInto("task_evidence").values({ task_id: id, kind: "file", ref_id: fileId }).execute();
}

export function generatorFor(resolve: (prompt: string) => ClusterVerdict): GeminiGenerator {
  return {
    async generate() {
      return "{}";
    },
    async generateJSON<T>(prompt: string) {
      return resolve(prompt) as T;
    },
  };
}

export function acceptanceBody(
  kind: "client" | "partner" | "vendor" | "investor" | "other",
  stage?: "prospect" | "pilot" | "active" | "dormant" | "ended",
): { confirmedCounterpartyKind: string; confirmedClientStage?: string } {
  return stage ? { confirmedCounterpartyKind: kind, confirmedClientStage: stage } : { confirmedCounterpartyKind: kind };
}

export async function loginAsAdmin(db: Kysely<DB>, app: ReturnType<typeof createApp>): Promise<string> {
  const settings = createSettingsRepository(db);
  await settings.ensure();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  await createUserRepository(db).create({
    name: "Admin",
    email: "admin@example.com",
    emailVerified: true,
    passwordHash: await hashPassword(FIXTURE_PASSWORD),
    authRole: "admin",
  });
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: FIXTURE_PASSWORD }),
  });
  if (response.status !== 200) throw new Error(`admin login failed: ${response.status}`);
  return response.headers.get("set-cookie") ?? "";
}
