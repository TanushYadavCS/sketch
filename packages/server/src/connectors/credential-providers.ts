import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config";
import { createMcpServerRepository } from "../db/repositories/mcp-servers";
import type { DB } from "../db/schema";
import { CanvasProvider, type CanvasSketchConnectorType } from "../integrations/canvas";
import { decryptCredentialEnvelope } from "./credential-envelope";
import { parseCredentials } from "./sync-utils";
import type { AccessTokenProvider, ConnectorCredentials, ConnectorType, OAuthCredentials } from "./types";

export type ConnectorCredentialSource = "local" | "canvas";

export type CredentialProviderConfig = Partial<
  Pick<
    Config,
    | "ENCRYPTION_KEY"
    | "CONNECTOR_CREDENTIAL_SOURCE"
    | "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM"
    | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH"
    | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
  >
>;

export interface ConnectorConfigCredentialRow {
  id: string;
  connector_type: string;
  credentials: string;
  credential_source?: string;
}

interface CanvasOAuthPayload {
  type: "oauth_access_token";
  connectorType: CanvasSketchConnectorType;
  provider: string;
  accessToken: string;
  tokenType?: string;
  expiresAt?: string;
  scope?: string;
}

interface CanvasApiKeyPayload {
  type: "api_key";
  connectorType: CanvasSketchConnectorType;
  provider: string;
  apiKey: string;
}

type CanvasCredentialPayload = CanvasOAuthPayload | CanvasApiKeyPayload;

export interface ResolvedConnectorCredentials {
  credentials: ConnectorCredentials;
  credentialSource: ConnectorCredentialSource;
  accessTokenProvider?: AccessTokenProvider;
}

export interface ConnectorCredentialProvider {
  readonly source: ConnectorCredentialSource;
  resolve(params: {
    config: ConnectorConfigCredentialRow;
    ownerEmail: string | null;
  }): Promise<ResolvedConnectorCredentials>;
}

export class ConnectorCredentialConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorCredentialConfigError";
  }
}

const CANVAS_CONNECTOR_TYPE_VALUES = [
  "google_drive",
  "google_calendar",
  "gmail",
  "outlook",
  "outlook_calendar",
  "teams",
  "fireflies",
  "clickup",
  "notion",
  "linear",
] as const satisfies readonly CanvasSketchConnectorType[];

const CANVAS_CONNECTOR_TYPES = new Set<ConnectorType>(CANVAS_CONNECTOR_TYPE_VALUES);

export const CANVAS_OAUTH_CONNECTOR_TYPES = [
  "google_drive",
  "google_calendar",
  "gmail",
  "outlook",
  "outlook_calendar",
  "teams",
] as const satisfies readonly ConnectorType[];

const CANVAS_OAUTH_CONNECTORS = new Set<ConnectorType>(CANVAS_OAUTH_CONNECTOR_TYPES);

const canvasConnectorTypeSchema = z.enum(CANVAS_CONNECTOR_TYPE_VALUES);
const canvasCredentialPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("oauth_access_token"),
    connectorType: canvasConnectorTypeSchema,
    provider: z.string().min(1),
    accessToken: z.string().min(1),
    tokenType: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("api_key"),
    connectorType: canvasConnectorTypeSchema,
    provider: z.string().min(1),
    apiKey: z.string().min(1),
  }),
]);

export function connectorCredentialMode(config?: CredentialProviderConfig): ConnectorCredentialSource {
  return config?.CONNECTOR_CREDENTIAL_SOURCE === "canvas" ? "canvas" : "local";
}

export function isCanvasCredentialMode(config?: CredentialProviderConfig): boolean {
  return connectorCredentialMode(config) === "canvas";
}

export function isCanvasOAuthConnector(connectorType: ConnectorType): boolean {
  return CANVAS_OAUTH_CONNECTORS.has(connectorType);
}

export function isCanvasConnector(connectorType: ConnectorType): boolean {
  return CANVAS_CONNECTOR_TYPES.has(connectorType);
}

export function isLocalConnectorBlockedInCanvasMode(
  config: CredentialProviderConfig | undefined,
  connectorType: ConnectorType,
): boolean {
  return isCanvasCredentialMode(config) && isCanvasConnector(connectorType);
}

export function hasCanvasCredentialImportConfig(config?: CredentialProviderConfig): boolean {
  return Boolean(
    config?.CANVAS_CREDENTIAL_PRIVATE_KEY_PEM?.trim() || config?.CANVAS_CREDENTIAL_PRIVATE_KEY_PATH?.trim(),
  );
}

export function assertCanvasCredentialImportConfigured(config?: CredentialProviderConfig): void {
  const privateKeyPem = getPrivateKeyPem(config ?? {});
  createPrivateKey(privateKeyPem);
}

export function storedCredentialEncryptionMissing(config?: CredentialProviderConfig): boolean {
  return Boolean(config?.CONNECTOR_CREDENTIAL_SOURCE) && !config?.ENCRYPTION_KEY;
}

export function assertStoredCredentialStorageConfigured(config?: CredentialProviderConfig): void {
  if (!storedCredentialEncryptionMissing(config)) return;
  throw new ConnectorCredentialConfigError(
    "ENCRYPTION_REQUIRED",
    "Set ENCRYPTION_KEY or CONNECTOR_CREDENTIAL_SOURCE=canvas before storing connector credentials",
  );
}

export async function connectorCredentialSourceStatus(params: {
  db: Kysely<DB>;
  appConfig?: CredentialProviderConfig;
}) {
  const canvasConfigured = Boolean(await createMcpServerRepository(params.db).findByType("canvas"));
  return {
    mode: connectorCredentialMode(params.appConfig),
    canvasConfigured,
    canvasCredentialImportConfigured: canvasConfigured && hasCanvasCredentialImportConfig(params.appConfig),
    publicKeyId: params.appConfig?.CANVAS_CREDENTIAL_PUBLIC_KEY_ID ?? null,
  };
}

function getPrivateKeyPem(config: CredentialProviderConfig): string {
  const fromEnv = config.CANVAS_CREDENTIAL_PRIVATE_KEY_PEM?.trim();
  if (fromEnv) return fromEnv.replace(/\\n/g, "\n");

  const fromPath = config.CANVAS_CREDENTIAL_PRIVATE_KEY_PATH?.trim();
  if (fromPath) return readFileSync(fromPath, "utf8");

  throw new ConnectorCredentialConfigError(
    "CANVAS_CREDENTIAL_IMPORT_NOT_CONFIGURED",
    "Canvas credential import requires CANVAS_CREDENTIAL_PRIVATE_KEY_PEM or CANVAS_CREDENTIAL_PRIVATE_KEY_PATH",
  );
}

function toCanvasConnectorType(connectorType: ConnectorType): CanvasSketchConnectorType {
  if (CANVAS_CONNECTOR_TYPES.has(connectorType)) {
    return connectorType as CanvasSketchConnectorType;
  }
  throw new Error(`Unsupported Canvas connector type: ${connectorType}`);
}

function toCredentials(payload: CanvasCredentialPayload): ConnectorCredentials {
  if (payload.type === "oauth_access_token") {
    return {
      type: "oauth",
      access_token: payload.accessToken,
      refresh_token: "",
      token_type: payload.tokenType ?? "Bearer",
      ...(payload.expiresAt ? { expires_at: payload.expiresAt } : {}),
      client_id: "canvas",
      client_secret: "canvas",
      ...(payload.scope ? { scope: payload.scope } : {}),
    };
  }

  return { type: "api_key", api_key: payload.apiKey };
}

function parseCanvasCredentialPayload(value: unknown): CanvasCredentialPayload {
  const parsed = canvasCredentialPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Canvas credential payload is invalid");
  }
  return parsed.data;
}

export function canvasOAuthPlaceholderCredentials(accountId?: string): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "",
    refresh_token: "",
    token_type: "Bearer",
    expires_at: new Date(0).toISOString(),
    client_id: "canvas",
    client_secret: "canvas",
    ...(accountId ? { canvas_account_id: accountId } : {}),
  };
}

function validateCanvasCredentialResponse(params: {
  requestedConnectorType: ConnectorType;
  requestedPublicKeyId?: string;
  response: Awaited<ReturnType<CanvasProvider["mintConnectorCredential"]>>;
  payload: CanvasCredentialPayload;
}) {
  const expectedKind = params.payload.type === "oauth_access_token" ? "oauth_access_token" : "api_key";

  if (params.requestedPublicKeyId && params.response.envelope.keyId !== params.requestedPublicKeyId) {
    throw new Error("Canvas credential envelope key id does not match the requested public key");
  }
  if (params.response.connectorType !== params.requestedConnectorType) {
    throw new Error("Canvas credential response connector type does not match the request");
  }
  if (params.payload.connectorType !== params.requestedConnectorType) {
    throw new Error("Canvas credential payload connector type does not match the request");
  }
  if (params.response.provider !== params.payload.provider) {
    throw new Error("Canvas credential payload provider does not match the response");
  }
  if (params.response.credentialKind !== expectedKind) {
    throw new Error("Canvas credential payload kind does not match the response");
  }
}

class LocalConnectorCredentialProvider implements ConnectorCredentialProvider {
  readonly source = "local";

  constructor(private readonly appConfig: CredentialProviderConfig) {}

  async resolve(params: {
    config: ConnectorConfigCredentialRow;
    ownerEmail: string | null;
  }): Promise<ResolvedConnectorCredentials> {
    return {
      credentialSource: "local",
      credentials: parseCredentials(params.config.credentials),
    };
  }
}

export class CanvasConnectorCredentialProvider implements ConnectorCredentialProvider {
  readonly source = "canvas";

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      appConfig: CredentialProviderConfig;
      logger: Logger;
    },
  ) {}

  hasCredentialImportConfig(): boolean {
    return hasCanvasCredentialImportConfig(this.deps.appConfig);
  }

  async loadProvider(): Promise<CanvasProvider> {
    const row = await createMcpServerRepository(this.deps.db).findByType("canvas");
    if (!row?.api_url || !row.credentials) {
      throw new ConnectorCredentialConfigError("CANVAS_NOT_CONFIGURED", "Canvas integration is not configured");
    }

    const credentials = JSON.parse(row.credentials) as { apiKey?: string };
    if (!credentials.apiKey) {
      throw new ConnectorCredentialConfigError(
        "CANVAS_API_KEY_NOT_CONFIGURED",
        "Canvas integration API key is not configured",
      );
    }

    return new CanvasProvider(row.api_url, credentials.apiKey, row.id);
  }

  async mint(params: {
    connectorType: ConnectorType;
    userEmail: string | null;
    accountId?: string;
    userName?: string | null;
    userOrgRole?: "admin" | "member";
  }): Promise<ConnectorCredentials> {
    if (!params.userEmail) {
      throw new Error("Canvas credential source requires a user email");
    }

    const provider = await this.loadProvider();
    const privateKeyPem = getPrivateKeyPem(this.deps.appConfig);
    const response = await provider.mintConnectorCredential({
      userEmail: params.userEmail,
      connectorType: toCanvasConnectorType(params.connectorType),
      publicKeyId: this.deps.appConfig.CANVAS_CREDENTIAL_PUBLIC_KEY_ID,
      accountId: params.accountId,
      userName: params.userName ?? undefined,
      userOrgRole: params.userOrgRole,
    });
    const payload = parseCanvasCredentialPayload(decryptCredentialEnvelope<unknown>(response.envelope, privateKeyPem));
    validateCanvasCredentialResponse({
      requestedConnectorType: params.connectorType,
      requestedPublicKeyId: this.deps.appConfig.CANVAS_CREDENTIAL_PUBLIC_KEY_ID,
      response,
      payload,
    });
    return toCredentials(payload);
  }

  createAccessTokenProvider(params: {
    connectorType: ConnectorType;
    userEmail: string | null;
    accountId?: string;
  }): AccessTokenProvider {
    let cached: { accessToken: string; expiresAt?: string } | null = null;

    return async (opts) => {
      const current = cached;
      const expiresAtMs = current?.expiresAt ? new Date(current.expiresAt).getTime() : 0;
      const stillValid = current && expiresAtMs > Date.now() + 60_000;
      if (stillValid && !opts?.forceRefresh) {
        return current;
      }

      const credentials = await this.mint({
        connectorType: params.connectorType,
        userEmail: params.userEmail,
        accountId: params.accountId,
      });
      if (credentials.type !== "oauth") {
        throw new Error("Canvas credential mint did not return OAuth credentials");
      }

      cached = {
        accessToken: credentials.access_token,
        expiresAt: credentials.expires_at,
      };
      this.deps.logger.debug({ connectorType: params.connectorType }, "Minted Canvas OAuth access token");
      return cached;
    };
  }

  async resolve(params: {
    config: ConnectorConfigCredentialRow;
    ownerEmail: string | null;
  }): Promise<ResolvedConnectorCredentials> {
    const connectorType = params.config.connector_type as ConnectorType;

    if (isCanvasOAuthConnector(connectorType)) {
      const storedCredentials = parseCredentials(params.config.credentials);
      const accountId = storedCredentials.type === "oauth" ? storedCredentials.canvas_account_id : undefined;
      const accessTokenProvider = this.createAccessTokenProvider({
        connectorType,
        userEmail: params.ownerEmail,
        accountId,
      });
      const minted = await accessTokenProvider();
      return {
        credentialSource: "canvas",
        credentials: {
          ...canvasOAuthPlaceholderCredentials(accountId),
          access_token: minted.accessToken,
          expires_at: minted.expiresAt,
        },
        accessTokenProvider,
      };
    }

    return {
      credentialSource: "canvas",
      credentials: parseCredentials(params.config.credentials),
    };
  }
}

export function createConnectorCredentialProvider(params: {
  db: Kysely<DB>;
  appConfig: CredentialProviderConfig;
  logger: Logger;
  config: ConnectorConfigCredentialRow;
}): ConnectorCredentialProvider {
  if (params.config.credential_source === "canvas") {
    return new CanvasConnectorCredentialProvider({
      db: params.db,
      appConfig: params.appConfig,
      logger: params.logger,
    });
  }

  return new LocalConnectorCredentialProvider(params.appConfig);
}

export async function resolveConnectorCredentials(params: {
  db: Kysely<DB>;
  config: ConnectorConfigCredentialRow;
  appConfig: CredentialProviderConfig;
  ownerEmail: string | null;
  logger: Logger;
}): Promise<ResolvedConnectorCredentials> {
  return createConnectorCredentialProvider(params).resolve({
    config: params.config,
    ownerEmail: params.ownerEmail,
  });
}
