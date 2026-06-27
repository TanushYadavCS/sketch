import { readFileSync } from "node:fs";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { Config } from "../config";
import { createMcpServerRepository } from "../db/repositories/mcp-servers";
import type { DB } from "../db/schema";
import { CanvasProvider, type CanvasSketchConnectorType } from "../integrations/canvas";
import { decryptCredentialEnvelope } from "./credential-envelope";
import { parseCredentials } from "./sync-utils";
import type { AccessTokenProvider, ConnectorCredentials, ConnectorType } from "./types";

interface ConnectorConfigRow {
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
  credentialSource: "local" | "canvas";
  accessTokenProvider?: AccessTokenProvider;
}

const CANVAS_CONNECTOR_TYPES = new Set<ConnectorType>([
  "google_drive",
  "google_calendar",
  "gmail",
  "outlook",
  "teams",
  "fireflies",
  "clickup",
  "notion",
  "linear",
]);

const CANVAS_OAUTH_CONNECTORS = new Set<ConnectorType>([
  "google_drive",
  "google_calendar",
  "gmail",
  "outlook",
  "teams",
]);

export function isCanvasOAuthConnector(connectorType: ConnectorType): boolean {
  return CANVAS_OAUTH_CONNECTORS.has(connectorType);
}

export function isCanvasConnector(connectorType: ConnectorType): boolean {
  return CANVAS_CONNECTOR_TYPES.has(connectorType);
}

function getPrivateKeyPem(
  config: Partial<Pick<Config, "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM" | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH">>,
): string {
  const fromEnv = config.CANVAS_CREDENTIAL_PRIVATE_KEY_PEM?.trim();
  if (fromEnv) return fromEnv.replace(/\\n/g, "\n");

  const fromPath = config.CANVAS_CREDENTIAL_PRIVATE_KEY_PATH?.trim();
  if (fromPath) return readFileSync(fromPath, "utf8");

  throw new Error(
    "Canvas credential source requires CANVAS_CREDENTIAL_PRIVATE_KEY_PEM or CANVAS_CREDENTIAL_PRIVATE_KEY_PATH",
  );
}

export async function loadCanvasProvider(db: Kysely<DB>): Promise<CanvasProvider> {
  const repo = createMcpServerRepository(db);
  const row = await repo.findByType("canvas");
  if (!row?.api_url || !row.credentials) {
    throw new Error("Canvas integration is not configured");
  }

  const credentials = JSON.parse(row.credentials) as { apiKey?: string };
  if (!credentials.apiKey) {
    throw new Error("Canvas integration API key is not configured");
  }

  return new CanvasProvider(row.api_url, credentials.apiKey, row.id);
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

export async function fetchCanvasCredential(params: {
  db: Kysely<DB>;
  appConfig: Partial<
    Pick<
      Config,
      "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM" | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH" | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
    >
  >;
  connectorType: ConnectorType;
  userEmail: string | null;
  userName?: string | null;
  userOrgRole?: "admin" | "member";
}): Promise<ConnectorCredentials> {
  if (!params.userEmail) {
    throw new Error("Canvas credential source requires a user email");
  }

  const provider = await loadCanvasProvider(params.db);
  const privateKeyPem = getPrivateKeyPem(params.appConfig);
  const response = await provider.mintConnectorCredential({
    userEmail: params.userEmail,
    connectorType: toCanvasConnectorType(params.connectorType),
    publicKeyId: params.appConfig.CANVAS_CREDENTIAL_PUBLIC_KEY_ID,
    userName: params.userName ?? undefined,
    userOrgRole: params.userOrgRole,
  });
  const payload = decryptCredentialEnvelope<CanvasCredentialPayload>(response.envelope, privateKeyPem);
  validateCanvasCredentialResponse({
    requestedConnectorType: params.connectorType,
    requestedPublicKeyId: params.appConfig.CANVAS_CREDENTIAL_PUBLIC_KEY_ID,
    response,
    payload,
  });
  return toCredentials(payload);
}

export function createCanvasAccessTokenProvider(params: {
  db: Kysely<DB>;
  appConfig: Partial<
    Pick<
      Config,
      "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM" | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH" | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
    >
  >;
  connectorType: ConnectorType;
  userEmail: string | null;
  logger: Logger;
}): AccessTokenProvider {
  let cached: { accessToken: string; expiresAt?: string } | null = null;

  return async (opts) => {
    const current = cached;
    const expiresAtMs = current?.expiresAt ? new Date(current.expiresAt).getTime() : 0;
    const stillValid = current && expiresAtMs > Date.now() + 60_000;
    if (stillValid && !opts?.forceRefresh) {
      return current;
    }

    const credentials = await fetchCanvasCredential({
      db: params.db,
      appConfig: params.appConfig,
      connectorType: params.connectorType,
      userEmail: params.userEmail,
    });
    if (credentials.type !== "oauth") {
      throw new Error("Canvas credential mint did not return OAuth credentials");
    }

    cached = {
      accessToken: credentials.access_token,
      expiresAt: credentials.expires_at,
    };
    params.logger.debug({ connectorType: params.connectorType }, "Minted Canvas OAuth access token");
    return cached;
  };
}

export async function resolveConnectorCredentials(params: {
  db: Kysely<DB>;
  config: ConnectorConfigRow;
  appConfig: Partial<
    Pick<
      Config,
      | "ENCRYPTION_KEY"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH"
      | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
    >
  >;
  ownerEmail: string | null;
  logger: Logger;
}): Promise<ResolvedConnectorCredentials> {
  const credentialSource = params.config.credential_source === "canvas" ? "canvas" : "local";
  const connectorType = params.config.connector_type as ConnectorType;

  if (credentialSource === "canvas" && isCanvasOAuthConnector(connectorType)) {
    const accessTokenProvider = createCanvasAccessTokenProvider({
      db: params.db,
      appConfig: params.appConfig,
      connectorType,
      userEmail: params.ownerEmail,
      logger: params.logger,
    });
    const minted = await accessTokenProvider();
    return {
      credentialSource,
      credentials: {
        type: "oauth",
        access_token: minted.accessToken,
        refresh_token: "",
        token_type: "Bearer",
        ...(minted.expiresAt ? { expires_at: minted.expiresAt } : {}),
        client_id: "canvas",
        client_secret: "canvas",
      },
      accessTokenProvider,
    };
  }

  return {
    credentialSource,
    credentials: parseCredentials(params.config.credentials),
  };
}
