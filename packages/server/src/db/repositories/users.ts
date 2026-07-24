import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import type { DB, UsersTable } from "../schema";
import { invalidateSettingsCache } from "./settings";

type UserDb = Kysely<DB> | Transaction<DB>;
type UserRow = Selectable<UsersTable>;

export interface UserRepository {
  list(): Promise<UserRow[]>;
  listExternal(): Promise<UserRow[]>;
  findBySlackId(slackUserId: string): Promise<UserRow | undefined>;
  findByWhatsappNumber(whatsappNumber: string): Promise<UserRow | undefined>;
  findByEmail(email: string): Promise<UserRow | undefined>;
  findById(id: string): Promise<UserRow | undefined>;
  findFirstAdmin(): Promise<UserRow | undefined>;
  findFirstLocalAdmin(): Promise<UserRow | undefined>;
  listAdmins(): Promise<UserRow[]>;
  getAllEmailsForUser(id: string): Promise<string[]>;
  getVerifiedEmailsForUser(id: string): Promise<string[]>;
  findByExactName(name: string, excludeUserId?: string): Promise<UserRow | undefined>;
  searchByNamePrefix(query: string, limit?: number, excludeUserId?: string): Promise<UserRow[]>;
  searchByNameSubstring(query: string, limit?: number, excludeUserId?: string): Promise<UserRow[]>;
  create(data: {
    id?: string;
    name: string;
    slackUserId?: string;
    whatsappNumber?: string;
    email?: string | null;
    emailVerified?: boolean;
    passwordHash?: string | null;
    authRole?: "admin" | "member";
    description?: string;
    type?: string;
    role?: string;
    reportsTo?: string;
    allowedTools?: string[] | null;
  }): Promise<UserRow>;
  update(
    id: string,
    data: {
      name?: string;
      email?: string | null;
      emailVerified?: boolean;
      passwordHash?: string | null;
      authRole?: "admin" | "member";
      whatsappNumber?: string | null;
      slackUserId?: string | null;
      description?: string | null;
      role?: string | null;
      reportsTo?: string | null;
      toolProgress?: string | null;
      reasoningText?: boolean | null;
      allowedTools?: string[] | null;
      timezone?: string | null;
    },
  ): Promise<UserRow>;
  remove(id: string): Promise<unknown>;
  transaction<T>(callback: (repo: UserRepository) => Promise<T>): Promise<T>;
}

interface SettingsCacheInvalidationContext {
  cacheDb: object;
  deferred?: { pending: boolean };
}

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

function recordSettingsWrite(context: SettingsCacheInvalidationContext): void {
  if (context.deferred) {
    context.deferred.pending = true;
    return;
  }
  invalidateSettingsCache(context.cacheDb);
}

export function createUserRepository(db: UserDb): UserRepository {
  return createUserRepositoryWithContext(db, { cacheDb: db });
}

function createUserRepositoryWithContext(
  db: UserDb,
  settingsCacheInvalidation: SettingsCacheInvalidationContext,
): UserRepository {
  return {
    async list() {
      return db.selectFrom("users").selectAll().where("type", "!=", "external").orderBy("created_at", "desc").execute();
    },

    async listExternal() {
      return db.selectFrom("users").selectAll().where("type", "=", "external").orderBy("created_at", "desc").execute();
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
        WHERE lower(trim(email)) = ${normalizeEmail(email)}
        LIMIT 1
      `.execute(db);
      return rows.rows[0];
    },

    async findById(id: string) {
      return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async findFirstAdmin() {
      return db
        .selectFrom("users")
        .selectAll()
        .where("auth_role", "=", "admin")
        .orderBy("created_at", "asc")
        .executeTakeFirst();
    },

    async findFirstLocalAdmin() {
      return db
        .selectFrom("users")
        .selectAll()
        .where("auth_role", "=", "admin")
        .where("password_hash", "is not", null)
        .orderBy("created_at", "asc")
        .executeTakeFirst();
    },

    async listAdmins() {
      return db
        .selectFrom("users")
        .selectAll()
        .where("auth_role", "=", "admin")
        .where("type", "!=", "external")
        .orderBy("created_at", "asc")
        .execute();
    },

    async getAllEmailsForUser(userId: string): Promise<string[]> {
      const [user, identities] = await Promise.all([
        db.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst(),
        db
          .selectFrom("user_provider_identities")
          .select("provider_email")
          .where("user_id", "=", userId)
          .where("provider_email", "is not", null)
          .execute(),
      ]);
      const emails: string[] = [];
      if (user?.email) emails.push(user.email);
      for (const row of identities) {
        if (row.provider_email && !emails.includes(row.provider_email)) {
          emails.push(row.provider_email);
        }
      }
      return emails;
    },

    async getVerifiedEmailsForUser(userId: string): Promise<string[]> {
      const [user, identities] = await Promise.all([
        db
          .selectFrom("users")
          .select("email")
          .where("id", "=", userId)
          .where("email_verified_at", "is not", null)
          .executeTakeFirst(),
        db
          .selectFrom("user_provider_identities")
          .select("provider_email")
          .where("user_id", "=", userId)
          .where("provider_email", "is not", null)
          .execute(),
      ]);
      const emails: string[] = [];
      if (user?.email) emails.push(user.email);
      for (const row of identities) {
        if (row.provider_email && !emails.includes(row.provider_email)) {
          emails.push(row.provider_email);
        }
      }
      return emails;
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
      id?: string;
      name: string;
      slackUserId?: string;
      whatsappNumber?: string;
      email?: string | null;
      emailVerified?: boolean;
      passwordHash?: string | null;
      authRole?: "admin" | "member";
      description?: string;
      type?: string;
      role?: string;
      reportsTo?: string;
      allowedTools?: string[] | null;
    }) {
      const id = data.id ?? randomUUID();
      await db
        .insertInto("users")
        .values({
          id,
          name: data.name,
          email: data.email ?? null,
          email_verified_at: data.email && data.emailVerified ? new Date().toISOString() : null,
          password_hash: data.passwordHash ?? null,
          auth_role: data.authRole ?? "member",
          slack_user_id: data.slackUserId ?? null,
          whatsapp_number: data.whatsappNumber ?? null,
          description: data.description ?? null,
          type: data.type ?? "human",
          role: data.role ?? null,
          reports_to: data.reportsTo ?? null,
          allowed_tools: data.allowedTools == null ? null : JSON.stringify(data.allowedTools),
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
        passwordHash?: string | null;
        authRole?: "admin" | "member";
        whatsappNumber?: string | null;
        slackUserId?: string | null;
        description?: string | null;
        role?: string | null;
        reportsTo?: string | null;
        toolProgress?: string | null;
        reasoningText?: boolean | null;
        allowedTools?: string[] | null;
        timezone?: string | null;
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
      if (data.passwordHash !== undefined) values.password_hash = data.passwordHash;
      if (data.authRole !== undefined) values.auth_role = data.authRole;
      if (data.whatsappNumber !== undefined) values.whatsapp_number = data.whatsappNumber;
      if (data.slackUserId !== undefined) values.slack_user_id = data.slackUserId;
      if (data.description !== undefined) values.description = data.description;
      if (data.role !== undefined) values.role = data.role;
      if (data.reportsTo !== undefined) values.reports_to = data.reportsTo;
      if (data.toolProgress !== undefined) values.tool_progress = data.toolProgress;
      if (data.reasoningText !== undefined)
        values.reasoning_text = data.reasoningText == null ? null : data.reasoningText ? 1 : 0;
      if (data.allowedTools !== undefined)
        values.allowed_tools = data.allowedTools == null ? null : JSON.stringify(data.allowedTools);
      if (data.timezone !== undefined) values.timezone = data.timezone;

      if (Object.keys(values).length > 0) {
        await db.updateTable("users").set(values).where("id", "=", id).execute();
      }

      return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async remove(id: string) {
      await db
        .deleteFrom("agent_environment_variable_shares")
        .where("variable_id", "in", db.selectFrom("agent_environment_variables").select("id").where("user_id", "=", id))
        .execute();
      await db.deleteFrom("agent_environment_variable_shares").where("created_by", "=", id).execute();
      await db.deleteFrom("agent_environment_variables").where("user_id", "=", id).execute();
      await db.deleteFrom("user_provider_identities").where("user_id", "=", id).execute();
      await db.deleteFrom("email_verification_tokens").where("user_id", "=", id).execute();
      await db.deleteFrom("magic_link_tokens").where("user_id", "=", id).execute();
      await db
        .deleteFrom("inbox_messages")
        .where((eb) => eb.or([eb("sender_user_id", "=", id), eb("recipient_user_id", "=", id)]))
        .execute();
      await db.updateTable("users").set({ reports_to: null }).where("reports_to", "=", id).execute();
      await db.updateTable("channels").set({ agent_user_id: null }).where("agent_user_id", "=", id).execute();
      await db.updateTable("whatsapp_groups").set({ agent_user_id: null }).where("agent_user_id", "=", id).execute();
      await db
        .updateTable("settings")
        .set({ whatsapp_fallback_agent_id: null })
        .where("whatsapp_fallback_agent_id", "=", id)
        .execute();
      recordSettingsWrite(settingsCacheInvalidation);
      await db.updateTable("tasks").set({ created_by_user_id: null }).where("created_by_user_id", "=", id).execute();
      return db.deleteFrom("users").where("id", "=", id).execute();
    },

    async transaction<T>(callback: (repo: UserRepository) => Promise<T>) {
      if (settingsCacheInvalidation.deferred) {
        return db
          .transaction()
          .execute(async (trx) => callback(createUserRepositoryWithContext(trx, settingsCacheInvalidation)));
      }

      const deferred = { pending: false };
      const result = await db.transaction().execute(async (trx) =>
        callback(
          createUserRepositoryWithContext(trx, {
            cacheDb: settingsCacheInvalidation.cacheDb,
            deferred,
          }),
        ),
      );
      if (deferred.pending) {
        invalidateSettingsCache(settingsCacheInvalidation.cacheDb);
      }
      return result;
    },
  };
}
