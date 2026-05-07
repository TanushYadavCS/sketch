import { randomBytes } from "node:crypto";
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/schema";

const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Find a user by email who has a verified email address.
 * Uses LOWER() for case-insensitive matching (Postgres-safe).
 */
export interface VerifiedUser {
  id: string;
  name: string;
  email: string;
  slack_user_id: string | null;
  whatsapp_number: string | null;
}

export async function findVerifiedUserByEmail(db: Kysely<DB>, email: string): Promise<VerifiedUser | null> {
  const user = await db
    .selectFrom("users")
    .select(["id", "name", "email", "slack_user_id", "whatsapp_number", "type"])
    .where(sql`LOWER(email)`, "=", email.toLowerCase())
    .where("email_verified_at", "is not", null)
    .executeTakeFirst();

  if (!user?.email) return null;
  // Agents and external users have no dashboard auth; magic links are
  // human-only.
  if (user.type === "agent" || user.type === "external") return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    slack_user_id: user.slack_user_id ?? null,
    whatsapp_number: user.whatsapp_number ?? null,
  };
}

/**
 * Atomically check the rate limit and create a magic link token in a single transaction.
 * Returns the token string if created, or null if rate-limited.
 * The transaction prevents TOCTOU races where concurrent requests could all pass the
 * count check before any tokens are inserted.
 */
export async function createRateLimitedMagicLinkToken(db: Kysely<DB>, userId: string): Promise<string | null> {
  return db.transaction().execute(async (tx) => {
    // Clean up expired tokens for this user
    await tx
      .deleteFrom("magic_link_tokens")
      .where("user_id", "=", userId)
      .where("expires_at", "<", new Date().toISOString())
      .execute();

    // Check rate limit inside the transaction
    const fifteenMinAgo = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count } = await tx
      .selectFrom("magic_link_tokens")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("user_id", "=", userId)
      .where("created_at", ">", fifteenMinAgo)
      .executeTakeFirstOrThrow();

    if (count >= RATE_LIMIT) return null;

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

    await tx
      .insertInto("magic_link_tokens")
      .values({ token, user_id: userId, expires_at: expiresAt, created_at: new Date().toISOString() })
      .execute();

    return token;
  });
}

/**
 * Verify a magic link token. Uses an atomic UPDATE … RETURNING to prevent double-use
 * race conditions and read the user_id in a single query. The WHERE clause ensures only
 * an unused, non-expired token is matched.
 */
export async function verifyMagicLinkToken(db: Kysely<DB>, token: string): Promise<string | null> {
  const row = await db
    .updateTable("magic_link_tokens")
    .set({ used_at: new Date().toISOString() })
    .where("token", "=", token)
    .where("used_at", "is", null)
    .where("expires_at", ">", new Date().toISOString())
    .returning("user_id")
    .executeTakeFirst();

  return row?.user_id ?? null;
}
