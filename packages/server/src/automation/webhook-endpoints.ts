import type { Kysely } from "kysely";
import {
  type WebhookEndpointRepositoryOptions,
  type WebhookEndpointRotationResult,
  type WebhookEndpointRow,
  createWebhookEndpointsRepository,
} from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import {
  type VerifyWebhookAuthInput,
  WEBHOOK_BODY_LIMIT_BYTES,
  WEBHOOK_ENDPOINT_PATH,
  WEBHOOK_IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  verifyWebhookAuth,
} from "./webhook-auth";

export const NATIVE_WEBHOOK_PATH = WEBHOOK_ENDPOINT_PATH;
export const NATIVE_WEBHOOK_METHOD = "POST" as const;
export const NATIVE_WEBHOOK_CONTENT_TYPE = "application/json" as const;

export interface WebhookEndpointConfiguration {
  readonly endpointId: string;
  readonly taskId: string;
  readonly url: string;
  readonly method: typeof NATIVE_WEBHOOK_METHOD;
  readonly contentType: typeof NATIVE_WEBHOOK_CONTENT_TYPE;
  readonly authentication: readonly ["bearer", "hmac"];
  readonly authorizationHeader: "Authorization";
  readonly signatureHeader: typeof WEBHOOK_SIGNATURE_HEADER;
  readonly idempotencyHeader: typeof WEBHOOK_IDEMPOTENCY_KEY_HEADER;
  readonly bodyLimitBytes: typeof WEBHOOK_BODY_LIMIT_BYTES;
  readonly secret: string | null;
  readonly credential: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
}

export interface WebhookEndpointServiceOptions {
  readonly db: Kysely<DB>;
  readonly encryptionKey?: string;
  readonly baseUrl?: string | null;
  readonly port?: number;
  readonly repositoryOptions?: Omit<WebhookEndpointRepositoryOptions, "encryptionKey">;
}

export interface WebhookAuthenticatedEndpoint {
  readonly endpoint: WebhookEndpointConfiguration;
  readonly auth: ReturnType<typeof verifyWebhookAuth>;
}

export function buildNativeWebhookUrl(
  endpointId: string,
  options: { readonly baseUrl?: string | null; readonly port?: number } = {},
): string {
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/u, "") || `http://localhost:${options.port ?? 3000}`;
  return `${baseUrl}${NATIVE_WEBHOOK_PATH}/${encodeURIComponent(endpointId)}`;
}

function configurationFor(
  row: WebhookEndpointRow,
  options: Pick<WebhookEndpointServiceOptions, "baseUrl" | "port">,
  secret: string | null,
): WebhookEndpointConfiguration {
  return {
    endpointId: row.id,
    taskId: row.task_id,
    url: buildNativeWebhookUrl(row.id, options),
    method: NATIVE_WEBHOOK_METHOD,
    contentType: NATIVE_WEBHOOK_CONTENT_TYPE,
    authentication: ["bearer", "hmac"],
    authorizationHeader: "Authorization",
    signatureHeader: WEBHOOK_SIGNATURE_HEADER,
    idempotencyHeader: WEBHOOK_IDEMPOTENCY_KEY_HEADER,
    bodyLimitBytes: WEBHOOK_BODY_LIMIT_BYTES,
    secret,
    credential: secret,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

export function createWebhookEndpointService(
  optionsOrDb: WebhookEndpointServiceOptions | Kysely<DB>,
  encryptionKey?: string,
  urlOptions?: {
    readonly baseUrl?: string | null;
    readonly port?: number;
    readonly repositoryOptions?: Omit<WebhookEndpointRepositoryOptions, "encryptionKey">;
  },
) {
  const resolved: WebhookEndpointServiceOptions =
    "db" in optionsOrDb
      ? optionsOrDb
      : {
          db: optionsOrDb,
          encryptionKey,
          baseUrl: urlOptions?.baseUrl,
          port: urlOptions?.port,
          repositoryOptions: urlOptions?.repositoryOptions,
        };
  const repository = createWebhookEndpointsRepository(resolved.db, resolved.encryptionKey, resolved.repositoryOptions);
  const endpointUrlOptions = { baseUrl: resolved.baseUrl, port: resolved.port };

  const ensureForTask = async (taskId: string): Promise<WebhookEndpointConfiguration> => {
    const result = await repository.ensureForTask(taskId);
    return configurationFor(result.endpoint, endpointUrlOptions, result.secret);
  };
  const getById = async (endpointId: string): Promise<WebhookEndpointConfiguration | null> => {
    const row = await repository.getById(endpointId);
    return row ? configurationFor(row, endpointUrlOptions, null) : null;
  };
  const getByTaskId = async (taskId: string): Promise<WebhookEndpointConfiguration | null> => {
    const row = await repository.getByTaskId(taskId);
    return row ? configurationFor(row, endpointUrlOptions, null) : null;
  };
  const rotateForTask = async (taskId: string): Promise<WebhookEndpointConfiguration | null> => {
    const result: WebhookEndpointRotationResult | undefined = await repository.rotateForTask(taskId);
    return result ? configurationFor(result.endpoint, endpointUrlOptions, result.secret) : null;
  };
  const revokeForTask = async (taskId: string): Promise<WebhookEndpointConfiguration | null> => {
    const row = await repository.revokeForTask(taskId);
    return row ? configurationFor(row, endpointUrlOptions, null) : null;
  };

  return {
    ensureForTask,
    provisionForTask: ensureForTask,
    getById,
    getByTaskId,
    get: getById,
    rotateForTask,
    rotate: rotateForTask,
    revokeForTask,
    revoke: revokeForTask,
    async deleteByTaskId(taskId: string): Promise<void> {
      await repository.deleteByTaskId(taskId);
    },

    async authenticate(endpointId: string, input: Omit<VerifyWebhookAuthInput, "secret">) {
      const stored = await repository.getSecretById(endpointId);
      if (!stored) return null;
      if (stored.endpoint.status !== "active") return null;
      return {
        endpoint: configurationFor(stored.endpoint, endpointUrlOptions, null),
        auth: verifyWebhookAuth({ ...input, secret: stored.secret }),
      } satisfies WebhookAuthenticatedEndpoint;
    },
  };
}
