import { randomBytes } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { decrypt, encrypt } from "../../auth/encryption";
import type { DB, SettingsTable } from "../schema";

export interface OrgContext {
  description?: string;
  industry?: string;
  /**
   * Dynamic extraction calibration is deliberately excluded from the prompt
   * version/fact key, so edits affect only future extraction runs.
   */
  disambiguationGuidance?: string;
}

export function parseOrgContext(raw: string | null | undefined): OrgContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: OrgContext = {};
    if (typeof parsed.description === "string" && parsed.description.trim().length > 0) {
      result.description = parsed.description.trim();
    }
    if (typeof parsed.industry === "string" && parsed.industry.trim().length > 0) {
      result.industry = parsed.industry.trim();
    }
    if (typeof parsed.disambiguationGuidance === "string" && parsed.disambiguationGuidance.trim().length > 0) {
      result.disambiguationGuidance = parsed.disambiguationGuidance.trim();
    }
    return result.description || result.industry || result.disambiguationGuidance ? result : null;
  } catch {
    return null;
  }
}

export function serializeOrgContext(context: OrgContext): string | null {
  const next: Record<string, string> = {};
  const description = context.description?.trim() ?? "";
  const industry = context.industry?.trim() ?? "";
  const disambiguationGuidance = context.disambiguationGuidance?.trim() ?? "";
  if (description.length > 0) next.description = description;
  if (industry.length > 0) next.industry = industry;
  if (disambiguationGuidance.length > 0) next.disambiguationGuidance = disambiguationGuidance;
  return Object.keys(next).length > 0 ? JSON.stringify(next) : null;
}

const SENSITIVE_FIELDS = new Set<string>([
  "slack_bot_token",
  "slack_app_token",
  "anthropic_api_key",
  "aws_secret_access_key",
  "gemini_api_key",
  "smtp_password",
  "google_oauth_client_secret",
  "microsoft_oauth_client_secret",
  "jwt_secret",
  "sketch_api_key",
]);

function buildSettingsInsert(
  encryptionKey: string | undefined,
  data: { adminEmail?: string; adminPasswordHash?: string; orgName?: string; botName?: string } = {},
) {
  const jwtSecret = randomBytes(32).toString("hex");
  return {
    id: "default",
    ...(data.adminEmail !== undefined ? { admin_email: data.adminEmail } : {}),
    ...(data.adminPasswordHash !== undefined ? { admin_password_hash: data.adminPasswordHash } : {}),
    jwt_secret: encryptionKey ? encrypt(jwtSecret, encryptionKey) : jwtSecret,
    ...(data.orgName !== undefined ? { org_name: data.orgName } : {}),
    ...(data.botName !== undefined ? { bot_name: data.botName } : {}),
  };
}

function decryptSettingsRow<T extends Record<string, unknown>>(row: T, encryptionKey?: string): T {
  const mutableRow = row as Record<string, unknown>;
  for (const field of SENSITIVE_FIELDS) {
    const value = mutableRow[field];
    if (typeof value === "string" && value.startsWith("enc:")) {
      if (!encryptionKey) {
        throw new Error(`Encrypted value found for ${field} but ENCRYPTION_KEY is not set`);
      }
      mutableRow[field] = decrypt(value, encryptionKey);
    }
  }
  return row;
}

/** Default process-local TTL for settings.get(). Writes always invalidate immediately. */
export const DEFAULT_SETTINGS_CACHE_TTL_MS = 30_000;

export interface SettingsRepositoryOptions {
  /**
   * Max age for a successful get() cache entry. Primary freshness is write
   * invalidation on create/ensure/update; TTL is a safety net only.
   * Set to 0 to disable TTL expiry (still invalidates on writes).
   */
  cacheTtlMs?: number;
  /** Clock for TTL checks — injectable for tests. */
  now?: () => number;
}

type SettingsRow = Selectable<SettingsTable>;

interface SettingsCacheBucket {
  cacheTtlMs: number;
  now: () => number;
  entry: { value: SettingsRow | null; expiresAt: number } | null;
  inflight: Promise<SettingsRow | null> | null;
}

/**
 * Per-db cache root. `generation` is shared so any write invalidates every
 * bucket. Entries/inflight are partitioned by encryption key and cache policy
 * so decrypted values and incompatible clock domains cannot cross repositories.
 */
interface SettingsDbCacheRoot {
  generation: number;
  buckets: Map<string, SettingsCacheBucket[]>;
}

/**
 * Cache is shared across repository instances for the same Kysely db +
 * encryption key. createApp and bootstrap each call createSettingsRepository();
 * without sharing, middleware would keep a stale row after settings.update()
 * from another instance. WeakMap drops state when the db is GC'd (tests).
 */
const cacheByDb = new WeakMap<object, SettingsDbCacheRoot>();

function cacheRootFor(db: Kysely<DB>): SettingsDbCacheRoot {
  let root = cacheByDb.get(db);
  if (!root) {
    root = { generation: 0, buckets: new Map() };
    cacheByDb.set(db, root);
  }
  return root;
}

function cacheBucketFor(
  root: SettingsDbCacheRoot,
  encryptionKey: string | undefined,
  cacheTtlMs: number,
  now: () => number,
): SettingsCacheBucket {
  const key = encryptionKey ?? "";
  let buckets = root.buckets.get(key);
  if (!buckets) {
    buckets = [];
    root.buckets.set(key, buckets);
  }
  let bucket = buckets.find((candidate) => candidate.cacheTtlMs === cacheTtlMs && candidate.now === now);
  if (!bucket) {
    bucket = { cacheTtlMs, now, entry: null, inflight: null };
    buckets.push(bucket);
  }
  return bucket;
}

function clearSettingsCacheRoot(root: SettingsDbCacheRoot): void {
  root.generation += 1;
  for (const buckets of root.buckets.values()) {
    for (const bucket of buckets) {
      bucket.entry = null;
      bucket.inflight = null;
    }
  }
}

/**
 * Bust process-local settings.get() cache for a db after a direct settings write
 * that does not go through createSettingsRepository (e.g. users.remove clearing
 * whatsapp_fallback_agent_id). Pass the same Kysely (or transaction) handle used
 * by createSettingsRepository for that process. No-op when nothing has been
 * cached for this handle.
 */
export function invalidateSettingsCache(db: object): void {
  const root = cacheByDb.get(db);
  if (!root) return;
  clearSettingsCacheRoot(root);
}

/**
 * Singleton settings row repository with a process-local get() cache.
 *
 * Auth middleware, adapters, and agent runtime all call get() frequently for a
 * single-row document. Cache hits avoid repeated SELECT + decrypt on the hot
 * path. Mutations (create / ensure / ensureSketchApiKey / update) bust the
 * cache so jwt_secret, onboarding, and authz flags stay correct after writes.
 *
 * Cache state is shared per (Kysely db, encryption key) so every matching
 * createSettingsRepository handle stays coherent. Writes invalidate all key
 * buckets for that db. Not distributed across processes.
 */
export function createSettingsRepository(db: Kysely<DB>, encryptionKey?: string, options?: SettingsRepositoryOptions) {
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_SETTINGS_CACHE_TTL_MS;
  const now = options?.now ?? Date.now;
  const root = cacheRootFor(db);
  const bucket = cacheBucketFor(root, encryptionKey, cacheTtlMs, now);

  function invalidateCache(): void {
    clearSettingsCacheRoot(root);
  }

  function cloneRow(row: SettingsRow): SettingsRow {
    return { ...row };
  }

  function readCache(): SettingsRow | null | undefined {
    if (!bucket.entry) return undefined;
    if (bucket.cacheTtlMs > 0 && bucket.now() >= bucket.entry.expiresAt) {
      bucket.entry = null;
      return undefined;
    }
    return bucket.entry.value === null ? null : cloneRow(bucket.entry.value);
  }

  function writeCache(value: SettingsRow | null, generationAtLoad: number): void {
    if (generationAtLoad !== root.generation) return;
    bucket.entry = {
      value: value === null ? null : cloneRow(value),
      expiresAt: bucket.cacheTtlMs > 0 ? bucket.now() + bucket.cacheTtlMs : Number.POSITIVE_INFINITY,
    };
  }

  async function loadFromDb(): Promise<SettingsRow | null> {
    const row = await db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirst();
    if (!row) return null;
    return decryptSettingsRow(row, encryptionKey);
  }

  return {
    async get() {
      const hit = readCache();
      if (hit !== undefined) return hit;

      if (bucket.inflight) {
        const shared = await bucket.inflight;
        return shared === null ? null : cloneRow(shared);
      }

      const generationAtLoad = root.generation;
      const pending = loadFromDb().then((loaded) => {
        writeCache(loaded, generationAtLoad);
        return loaded;
      });
      bucket.inflight = pending;
      try {
        const loaded = await pending;
        return loaded === null ? null : cloneRow(loaded);
      } finally {
        if (bucket.inflight === pending) bucket.inflight = null;
      }
    },

    async create(data: { adminEmail?: string; adminPasswordHash?: string; orgName?: string; botName?: string } = {}) {
      await db.insertInto("settings").values(buildSettingsInsert(encryptionKey, data)).execute();
      invalidateCache();

      return db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
    },

    async ensure() {
      await db
        .insertInto("settings")
        .values(buildSettingsInsert(encryptionKey))
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();

      invalidateCache();
      const generationAtLoad = root.generation;
      const row = await db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
      const decrypted = decryptSettingsRow(row, encryptionKey);
      writeCache(decrypted, generationAtLoad);
      return cloneRow(decrypted);
    },

    async ensureSketchApiKey(generateApiKey: () => string) {
      await db
        .insertInto("settings")
        .values(buildSettingsInsert(encryptionKey))
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();

      invalidateCache();
      const apiKey = generateApiKey();
      await db
        .updateTable("settings")
        .set({ sketch_api_key: encryptionKey ? encrypt(apiKey, encryptionKey) : apiKey })
        .where("id", "=", "default")
        .where("sketch_api_key", "is", null)
        .execute();

      invalidateCache();
      const generationAtLoad = root.generation;
      const row = await db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
      const decrypted = decryptSettingsRow(row, encryptionKey);
      writeCache(decrypted, generationAtLoad);
      if (!decrypted.sketch_api_key) {
        throw new Error("Sketch API key could not be ensured");
      }
      return decrypted.sketch_api_key;
    },

    async update(
      data: Partial<{
        adminEmail: string;
        adminPasswordHash: string;
        orgName: string;
        botName: string;
        onboardingCompletedAt: string;
        slackBotToken: string | null;
        slackAppToken: string | null;
        llmProvider: string | null;
        anthropicApiKey: string | null;
        awsAccessKeyId: string | null;
        awsSecretAccessKey: string | null;
        awsRegion: string | null;
        modelId: string | null;
        jwtSecret: string;
        smtpHost: string | null;
        smtpPort: number | null;
        smtpUser: string | null;
        smtpPassword: string | null;
        smtpFrom: string | null;
        smtpSecure: number | null;
        googleOauthClientId: string | null;
        googleOauthClientSecret: string | null;
        microsoftOauthClientId: string | null;
        microsoftOauthClientSecret: string | null;
        microsoftOauthTenant: string | null;
        geminiApiKey: string | null;
        embeddingProvider: string | null;
        enrichmentEnabled: number | null;
        adminCanReadAllFiles: boolean;
        syncIntervalMinutes: number | null;
        orgContext: string | null;
        sketchApiKey: string | null;
        whatsappFallbackAgentId: string | null;
      }>,
    ) {
      const updates: Record<string, string | number | null> = {};
      if (data.adminEmail !== undefined) updates.admin_email = data.adminEmail;
      if (data.adminPasswordHash !== undefined) updates.admin_password_hash = data.adminPasswordHash;
      if (data.jwtSecret !== undefined) updates.jwt_secret = data.jwtSecret;
      if (data.orgName !== undefined) updates.org_name = data.orgName;
      if (data.orgContext !== undefined) updates.org_context = data.orgContext;
      if (data.botName !== undefined) updates.bot_name = data.botName;
      if (data.onboardingCompletedAt !== undefined) updates.onboarding_completed_at = data.onboardingCompletedAt;
      if (data.slackBotToken !== undefined) updates.slack_bot_token = data.slackBotToken;
      if (data.slackAppToken !== undefined) updates.slack_app_token = data.slackAppToken;
      if (data.llmProvider !== undefined) updates.llm_provider = data.llmProvider;
      if (data.anthropicApiKey !== undefined) updates.anthropic_api_key = data.anthropicApiKey;
      if (data.awsAccessKeyId !== undefined) updates.aws_access_key_id = data.awsAccessKeyId;
      if (data.awsSecretAccessKey !== undefined) updates.aws_secret_access_key = data.awsSecretAccessKey;
      if (data.awsRegion !== undefined) updates.aws_region = data.awsRegion;
      if (data.modelId !== undefined) updates.model_id = data.modelId;
      if (data.smtpHost !== undefined) updates.smtp_host = data.smtpHost;
      if (data.smtpPort !== undefined) updates.smtp_port = data.smtpPort;
      if (data.smtpUser !== undefined) updates.smtp_user = data.smtpUser;
      if (data.smtpPassword !== undefined) updates.smtp_password = data.smtpPassword;
      if (data.smtpFrom !== undefined) updates.smtp_from = data.smtpFrom;
      if (data.smtpSecure !== undefined) updates.smtp_secure = data.smtpSecure;
      if (data.googleOauthClientId !== undefined) updates.google_oauth_client_id = data.googleOauthClientId;
      if (data.googleOauthClientSecret !== undefined) updates.google_oauth_client_secret = data.googleOauthClientSecret;
      if (data.microsoftOauthClientId !== undefined) updates.microsoft_oauth_client_id = data.microsoftOauthClientId;
      if (data.microsoftOauthClientSecret !== undefined) {
        updates.microsoft_oauth_client_secret = data.microsoftOauthClientSecret;
      }
      if (data.microsoftOauthTenant !== undefined) updates.microsoft_oauth_tenant = data.microsoftOauthTenant;
      if (data.geminiApiKey !== undefined) updates.gemini_api_key = data.geminiApiKey;
      if (data.embeddingProvider !== undefined) updates.embedding_provider = data.embeddingProvider;
      if (data.enrichmentEnabled !== undefined) updates.enrichment_enabled = data.enrichmentEnabled;
      if (data.adminCanReadAllFiles !== undefined) updates.admin_can_read_all_files = data.adminCanReadAllFiles ? 1 : 0;
      if (data.syncIntervalMinutes !== undefined) updates.sync_interval_minutes = data.syncIntervalMinutes;
      if (data.sketchApiKey !== undefined) updates.sketch_api_key = data.sketchApiKey;
      if (data.whatsappFallbackAgentId !== undefined) updates.whatsapp_fallback_agent_id = data.whatsappFallbackAgentId;

      if (Object.keys(updates).length === 0) return;

      if (encryptionKey) {
        for (const field of SENSITIVE_FIELDS) {
          const value = updates[field];
          if (typeof value === "string") {
            updates[field] = encrypt(value, encryptionKey);
          }
        }
      }

      await db.updateTable("settings").set(updates).where("id", "=", "default").execute();
      invalidateCache();
    },
  };
}
