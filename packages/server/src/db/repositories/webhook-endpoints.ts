import { randomBytes, randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import { decrypt, encrypt } from "../../auth/encryption";
import type { DB, WebhookEndpointsTable } from "../schema";

export const WEBHOOK_ENDPOINT_STATUS_ACTIVE = "active" as const;
export const WEBHOOK_ENDPOINT_STATUS_REVOKED = "revoked" as const;

export type WebhookEndpointStatus = typeof WEBHOOK_ENDPOINT_STATUS_ACTIVE | typeof WEBHOOK_ENDPOINT_STATUS_REVOKED;
export type StoredWebhookEndpointRow = Selectable<WebhookEndpointsTable>;
export type WebhookEndpointRow = Omit<StoredWebhookEndpointRow, "secret">;

export interface WebhookEndpointRepositoryOptions {
  readonly encryptionKey?: string;
  readonly now?: () => string;
  readonly idGenerator?: () => string;
  readonly secretGenerator?: () => string;
}

export interface WebhookEndpointProvisionResult extends WebhookEndpointRow {
  readonly endpoint: WebhookEndpointRow;
  readonly secret: string | null;
  readonly created: boolean;
}

export interface WebhookEndpointRotationResult extends WebhookEndpointRow {
  readonly endpoint: WebhookEndpointRow;
  readonly secret: string;
}

function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function encodeSecret(secret: string, encryptionKey?: string): string {
  if (!encryptionKey?.trim()) throw new Error("ENCRYPTION_KEY is required for native webhook credentials");
  return encrypt(secret, encryptionKey);
}

export function decodeWebhookSecret(secret: string, encryptionKey?: string): string {
  if (!encryptionKey?.trim()) throw new Error("ENCRYPTION_KEY is required for native webhook credentials");
  if (!secret.startsWith("enc:")) throw new Error("Native webhook credential is not encrypted");
  return decrypt(secret, encryptionKey);
}

function safeMetadata(row: StoredWebhookEndpointRow): WebhookEndpointRow {
  const { secret: _secret, ...metadata } = row;
  return metadata;
}

function provisionResult(
  endpoint: WebhookEndpointRow,
  secret: string | null,
  created: boolean,
): WebhookEndpointProvisionResult {
  return { ...endpoint, endpoint, secret, created };
}

function rotationResult(endpoint: WebhookEndpointRow, secret: string): WebhookEndpointRotationResult {
  return { ...endpoint, endpoint, secret };
}

function parseOptions(
  encryptionKeyOrOptions?: string | WebhookEndpointRepositoryOptions,
  options?: Omit<WebhookEndpointRepositoryOptions, "encryptionKey">,
): WebhookEndpointRepositoryOptions {
  if (typeof encryptionKeyOrOptions === "string" || encryptionKeyOrOptions === undefined) {
    return { ...options, encryptionKey: encryptionKeyOrOptions };
  }
  return encryptionKeyOrOptions;
}

export function createWebhookEndpointsRepository(
  db: Kysely<DB>,
  encryptionKeyOrOptions?: string | WebhookEndpointRepositoryOptions,
  options?: Omit<WebhookEndpointRepositoryOptions, "encryptionKey">,
) {
  const repositoryOptions = parseOptions(encryptionKeyOrOptions, options);
  const now = repositoryOptions.now ?? (() => new Date().toISOString());
  const idGenerator = repositoryOptions.idGenerator ?? randomUUID;
  const secretGenerator = repositoryOptions.secretGenerator ?? generateSecret;

  async function getStoredById(id: string): Promise<StoredWebhookEndpointRow | undefined> {
    return db.selectFrom("webhook_endpoints").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async function getStoredByTaskId(taskId: string): Promise<StoredWebhookEndpointRow | undefined> {
    return db.selectFrom("webhook_endpoints").selectAll().where("task_id", "=", taskId).executeTakeFirst();
  }

  return {
    async ensureForTask(taskId: string): Promise<WebhookEndpointProvisionResult> {
      const existing = await getStoredByTaskId(taskId);
      if (existing) return provisionResult(safeMetadata(existing), null, false);

      const id = idGenerator();
      const secret = secretGenerator();
      const timestamp = now();
      const result = await db
        .insertInto("webhook_endpoints")
        .values({
          id,
          task_id: taskId,
          secret: encodeSecret(secret, repositoryOptions.encryptionKey),
          status: WEBHOOK_ENDPOINT_STATUS_ACTIVE,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict((oc) => oc.column("task_id").doNothing())
        .executeTakeFirst();
      const created = Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
      const row = await getStoredByTaskId(taskId);
      if (!row) throw new Error(`Webhook endpoint could not be ensured for task ${taskId}`);
      return provisionResult(safeMetadata(row), created ? secret : null, created);
    },

    async rotateForTask(taskId: string): Promise<WebhookEndpointRotationResult | undefined> {
      const existing = await getStoredByTaskId(taskId);
      if (!existing) return undefined;
      const secret = secretGenerator();
      const timestamp = now();
      await db
        .updateTable("webhook_endpoints")
        .set({
          secret: encodeSecret(secret, repositoryOptions.encryptionKey),
          status: WEBHOOK_ENDPOINT_STATUS_ACTIVE,
          generation: sql<number>`generation + 1`,
          updated_at: timestamp,
          rotated_at: timestamp,
          revoked_at: null,
        })
        .where("id", "=", existing.id)
        .execute();
      const row = await getStoredById(existing.id);
      if (!row) return undefined;
      return rotationResult(safeMetadata(row), secret);
    },

    async revokeForTask(taskId: string): Promise<WebhookEndpointRow | undefined> {
      const timestamp = now();
      await db
        .updateTable("webhook_endpoints")
        .set({
          status: WEBHOOK_ENDPOINT_STATUS_REVOKED,
          generation: sql<number>`generation + 1`,
          revoked_at: timestamp,
          updated_at: timestamp,
        })
        .where("task_id", "=", taskId)
        .execute();
      const row = await getStoredByTaskId(taskId);
      return row ? safeMetadata(row) : undefined;
    },

    async getById(id: string): Promise<WebhookEndpointRow | undefined> {
      const row = await getStoredById(id);
      return row ? safeMetadata(row) : undefined;
    },

    async getByTaskId(taskId: string): Promise<WebhookEndpointRow | undefined> {
      const row = await getStoredByTaskId(taskId);
      return row ? safeMetadata(row) : undefined;
    },

    async getSecretById(id: string): Promise<{ endpoint: WebhookEndpointRow; secret: string } | undefined> {
      const row = await getStoredById(id);
      if (!row) return undefined;
      return { endpoint: safeMetadata(row), secret: decodeWebhookSecret(row.secret, repositoryOptions.encryptionKey) };
    },

    async getSecretByTaskId(taskId: string): Promise<{ endpoint: WebhookEndpointRow; secret: string } | undefined> {
      const row = await getStoredByTaskId(taskId);
      if (!row) return undefined;
      return { endpoint: safeMetadata(row), secret: decodeWebhookSecret(row.secret, repositoryOptions.encryptionKey) };
    },

    async deleteByTaskId(taskId: string): Promise<void> {
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom("webhook_deliveries").where("task_id", "=", taskId).execute();
        await trx.deleteFrom("webhook_endpoints").where("task_id", "=", taskId).execute();
      });
    },
  };
}

export const createWebhookEndpointRepository = createWebhookEndpointsRepository;
