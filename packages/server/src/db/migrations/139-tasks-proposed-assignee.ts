import { type Kysely, sql } from "kysely";

type TaskRow = {
  id: string;
  assignee_entity_id: string | null;
  assignee_name: string | null;
};

type PersonRow = {
  id: string;
  name: string;
  aliases: string | null;
  metadata: string | null;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("tasks").addColumn("proposed_assignee_name", "text").execute();

  const rows = await sql<TaskRow>`
    SELECT id, assignee_entity_id, assignee_name
    FROM tasks
    WHERE provenance IN ('brief', 'summary')
      AND valid_to IS NULL
      AND (assignee_entity_id IS NOT NULL OR assignee_name IS NOT NULL)
  `.execute(db);

  for (const task of rows.rows) {
    const person = task.assignee_entity_id ? await loadPerson(db, task.assignee_entity_id) : null;
    const eligible = person ? await hasExactlyOneEligibleUser(db, person) : false;
    const proposedName = task.assignee_name ?? person?.name ?? null;
    if (!eligible && proposedName) {
      await sql`
        UPDATE tasks
        SET assignee_entity_id = NULL,
            assignee_name = NULL,
            proposed_assignee_name = ${proposedName}
        WHERE id = ${task.id}
      `.execute(db);
    }
  }
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("tasks").dropColumn("proposed_assignee_name").execute();
}

async function loadPerson(db: Kysely<unknown>, id: string): Promise<PersonRow | null> {
  const result = await sql<PersonRow>`
    SELECT id, name, aliases, metadata
    FROM entities
    WHERE id = ${id}
      AND source_type = 'person'
      AND deleted_at IS NULL
      AND merged_into_entity_id IS NULL
    LIMIT 1
  `.execute(db);
  return result.rows[0] ?? null;
}

async function hasExactlyOneEligibleUser(db: Kysely<unknown>, person: PersonRow): Promise<boolean> {
  const ids = new Set<string>();
  for (const id of await eligibleUserIdsByEmail(db, person)) ids.add(id);
  return ids.size === 1;
}

async function eligibleUserIdsByEmail(db: Kysely<unknown>, person: PersonRow): Promise<string[]> {
  const emails = [...personEmailKeys(person), ...(await contactEmails(db, person.id))];
  const unique = [...new Set(emails)];
  if (unique.length === 0) return [];
  const values = sql.join(
    unique.map((email) => sql`${email}`),
    sql`,`,
  );
  const userRows = await sql<{ id: string }>`
    SELECT id
    FROM users
    WHERE type != 'external'
      AND email IS NOT NULL
      AND email_verified_at IS NOT NULL
      AND lower(trim(email)) IN (${values})
  `.execute(db);
  const providerRows = await sql<{ id: string }>`
    SELECT users.id AS id
    FROM user_provider_identities
    INNER JOIN users ON users.id = user_provider_identities.user_id
    WHERE users.type != 'external'
      AND user_provider_identities.provider_email IS NOT NULL
      AND lower(trim(user_provider_identities.provider_email)) IN (${values})
  `.execute(db);
  return [...new Set([...userRows.rows, ...providerRows.rows].map((row) => row.id))];
}

async function contactEmails(db: Kysely<unknown>, entityId: string): Promise<string[]> {
  const rows = await sql<{ value: string }>`
    SELECT value
    FROM entity_contact_points
    WHERE entity_id = ${entityId}
      AND kind = 'email'
  `.execute(db);
  return rows.rows.flatMap((row) => {
    const email = normalizeEmail(row.value);
    return email ? [email] : [];
  });
}

function personEmailKeys(person: PersonRow): string[] {
  return [...parseStringArray(person.aliases), readMetadataEmail(person.metadata)].flatMap((value) => {
    const email = normalizeEmail(value);
    return email ? [email] : [];
  });
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readMetadataEmail(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const email = (parsed as { email?: unknown }).email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed?.includes("@") ? trimmed : null;
}
