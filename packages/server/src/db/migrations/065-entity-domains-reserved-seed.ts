/**
 * ELP-02 follow-up: seed RFC 2606 / RFC 6761 reserved domains as `shared`.
 *
 * `example.com`, `example.org`, `example.net`, `example.test` are reserved
 * for documentation and never resolve to a real organization. They show up
 * in test fixtures (`sarah@example.com`) and occasional sample payloads;
 * without this seed, threshold=1 promotion would create an "Example"
 * company on first contact.
 *
 * Split from 063 so existing dev DBs that already ran 063 still pick this
 * up on next startup. Same upsert semantics: a manual corporate override
 * already owning one of these domains is left alone.
 */
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

const RESERVED_DOMAINS = ["example.com", "example.org", "example.net", "example.test"];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const domain of RESERVED_DOMAINS) {
    const existing = await sql<{
      kind: string;
      source: string;
    }>`SELECT kind, source FROM entity_domains WHERE domain = ${domain}`.execute(db);
    if (existing.rows.length > 0) continue;
    await sql`
      INSERT INTO entity_domains (id, entity_id, domain, kind, is_primary, confidence, source, created_at)
      VALUES (${randomUUID()}, NULL, ${domain}, 'shared', 0, 1.0, 'manual', CURRENT_TIMESTAMP)
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const domain of RESERVED_DOMAINS) {
    await sql`
      DELETE FROM entity_domains
      WHERE domain = ${domain} AND kind = 'shared' AND source = 'manual' AND entity_id IS NULL
    `.execute(db);
  }
}
