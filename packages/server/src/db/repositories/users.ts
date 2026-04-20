import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, UsersTable } from "../schema";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function excludeUserIdSql(excludeUserId?: string) {
  return excludeUserId ? sql`AND id != ${excludeUserId}` : sql``;
}

export function createUserRepository(db: Kysely<DB>) {
  return {
    async list() {
      return db.selectFrom("users").selectAll().orderBy("created_at", "desc").execute();
    },

    async findBySlackId(slackUserId: string) {
      return db.selectFrom("users").selectAll().where("slack_user_id", "=", slackUserId).executeTakeFirst();
    },

    async findByWhatsappNumber(whatsappNumber: string) {
      return db.selectFrom("users").selectAll().where("whatsapp_number", "=", whatsappNumber).executeTakeFirst();
    },

    async findByEmail(email: string) {
      const rows = await sql<Selectable<UsersTable>>`
        SELECT *
        FROM users
        WHERE lower(email) = ${normalizeEmail(email)}
        LIMIT 1
      `.execute(db);
      return rows.rows[0];
    },

    async findById(id: string) {
      return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async findByExactName(name: string, excludeUserId?: string) {
      const rows = await sql<Selectable<UsersTable>>`
        SELECT *
        FROM users
        WHERE lower(trim(name)) = ${normalizeName(name)}
        ${excludeUserIdSql(excludeUserId)}
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(db);
      return rows.rows[0];
    },

    async searchByNamePrefix(query: string, limit = 5, excludeUserId?: string) {
      const normalizedQuery = normalizeName(query);
      const prefix = `${escapeLike(normalizedQuery)}%`;
      const tokenPrefix = `% ${escapeLike(normalizedQuery)}%`;
      const rows = await sql<Selectable<UsersTable>>`
        SELECT *
        FROM users
        WHERE (
          lower(name) LIKE ${prefix} ESCAPE '\\'
          OR lower(name) LIKE ${tokenPrefix} ESCAPE '\\'
        )
        ${excludeUserIdSql(excludeUserId)}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `.execute(db);
      return rows.rows;
    },

    async searchByNameSubstring(query: string, limit = 5, excludeUserId?: string) {
      const normalizedQuery = normalizeName(query);
      const pattern = `%${escapeLike(normalizedQuery)}%`;
      const rows = await sql<Selectable<UsersTable>>`
        SELECT *
        FROM users
        WHERE lower(name) LIKE ${pattern} ESCAPE '\\'
        ${excludeUserIdSql(excludeUserId)}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `.execute(db);
      return rows.rows;
    },

    async create(data: {
      name: string;
      slackUserId?: string;
      whatsappNumber?: string;
      email?: string | null;
      emailVerified?: boolean;
      description?: string;
      type?: string;
      role?: string;
      reportsTo?: string;
    }) {
      const id = randomUUID();
      await db
        .insertInto("users")
        .values({
          id,
          name: data.name,
          email: data.email ?? null,
          email_verified_at: data.email && data.emailVerified ? new Date().toISOString() : null,
          slack_user_id: data.slackUserId ?? null,
          whatsapp_number: data.whatsappNumber ?? null,
          description: data.description ?? null,
          type: data.type ?? "human",
          role: data.role ?? null,
          reports_to: data.reportsTo ?? null,
        })
        .execute();

      return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async update(
      id: string,
      data: {
        name?: string;
        email?: string | null;
        emailVerified?: boolean;
        whatsappNumber?: string | null;
        slackUserId?: string | null;
        description?: string | null;
        role?: string | null;
        reportsTo?: string | null;
        toolProgress?: string | null;
        reasoningText?: boolean | null;
      },
    ) {
      const values: Record<string, unknown> = {};
      if (data.name !== undefined) values.name = data.name;
      if (data.email !== undefined) {
        values.email = data.email;
        if (data.emailVerified) {
          values.email_verified_at = new Date().toISOString();
        } else {
          // Reset verification when email changes
          const existing = await db.selectFrom("users").select("email").where("id", "=", id).executeTakeFirst();
          const nextEmail = data.email ?? null;
          if (existing && existing.email !== nextEmail) {
            values.email_verified_at = null;
          }
        }
      } else if (data.emailVerified) {
        values.email_verified_at = new Date().toISOString();
      }
      if (data.whatsappNumber !== undefined) values.whatsapp_number = data.whatsappNumber;
      if (data.slackUserId !== undefined) values.slack_user_id = data.slackUserId;
      if (data.description !== undefined) values.description = data.description;
      if (data.role !== undefined) values.role = data.role;
      if (data.reportsTo !== undefined) values.reports_to = data.reportsTo;
      if (data.toolProgress !== undefined) values.tool_progress = data.toolProgress;
      if (data.reasoningText !== undefined)
        values.reasoning_text = data.reasoningText == null ? null : data.reasoningText ? 1 : 0;

      if (Object.keys(values).length > 0) {
        await db.updateTable("users").set(values).where("id", "=", id).execute();
      }

      return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async remove(id: string) {
      return db.deleteFrom("users").where("id", "=", id).execute();
    },
  };
}
