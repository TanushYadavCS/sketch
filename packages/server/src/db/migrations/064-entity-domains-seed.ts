/**
 * ELP-02: seed ~30 personal/shared domains so inference never proposes
 * "57 people at gmail.com work at gmail.com". Lives as a separate migration
 * so dev can replay it via down→up without touching the schema.
 *
 * Upsert semantics: an existing `kind='corporate', source='manual'` row is
 * the operator override path and must NOT be overwritten. Anything else is
 * left as-is when re-running (`ON CONFLICT DO NOTHING`).
 */
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

const PERSONAL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
  "me.com",
  "fastmail.com",
  "hey.com",
  "aol.com",
  "msn.com",
  "live.com",
  "ymail.com",
  "mail.com",
  "gmx.com",
  "zoho.com",
  "yandex.com",
  "tutanota.com",
  "pm.me",
];

const SHARED_DOMAINS = [
  "googlegroups.com",
  "slack.com",
  "discord.com",
  "intercom.io",
  "hubspot.com",
  "salesforce.com",
  "atlassian.net",
  "notion.so",
  "linear.app",
  "clickup.com",
  "zoom.us",
];

interface SeedRow {
  domain: string;
  kind: "personal" | "shared";
}

const SEED_ROWS: SeedRow[] = [
  ...PERSONAL_DOMAINS.map((d) => ({ domain: d, kind: "personal" as const })),
  ...SHARED_DOMAINS.map((d) => ({ domain: d, kind: "shared" as const })),
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const seed of SEED_ROWS) {
    // Skip if a manual corporate override already owns this domain.
    const existing = await sql<{
      kind: string;
      source: string;
    }>`SELECT kind, source FROM entity_domains WHERE domain = ${seed.domain}`.execute(db);
    if (existing.rows.length > 0) {
      // Either it's already personal/shared (no-op) or it's a manual corporate
      // override (leave alone). Either way, do nothing.
      continue;
    }
    await sql`
      INSERT INTO entity_domains (id, entity_id, domain, kind, is_primary, confidence, source, created_at)
      VALUES (${randomUUID()}, NULL, ${seed.domain}, ${seed.kind}, 0, 1.0, 'manual', CURRENT_TIMESTAMP)
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse only the rows this migration owns (personal/shared, manual).
  // Manual corporate overrides survive; observed/llm rows survive (they're not ours).
  for (const seed of SEED_ROWS) {
    await sql`
      DELETE FROM entity_domains
      WHERE domain = ${seed.domain} AND kind = ${seed.kind} AND source = 'manual' AND entity_id IS NULL
    `.execute(db);
  }
}
