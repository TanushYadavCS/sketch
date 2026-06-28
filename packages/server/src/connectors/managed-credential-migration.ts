import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { encodeSecretField } from "../auth/secret-fields";
import type { Config } from "../config";
import type { DB } from "../db/schema";
import {
  CANVAS_OAUTH_CONNECTOR_TYPES,
  CanvasConnectorCredentialProvider,
  canvasOAuthPlaceholderCredentials,
  isCanvasCredentialMode,
} from "./credential-providers";
import type { ConnectorCredentials, ConnectorType, SyncStatus } from "./types";

const MIGRATION_MINT_TIMEOUT_MS = 10_000;

type ManagedCredentialMigrationConfig = Partial<
  Pick<
    Config,
    | "CONNECTOR_CREDENTIAL_SOURCE"
    | "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM"
    | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH"
    | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
    | "ENCRYPTION_KEY"
  >
>;

interface ManagedLocalOAuthConnectorRow {
  id: string;
  connector_type: string;
  sync_status: string;
  created_by: string;
  owner_email: string | null;
  owner_name: string | null;
  owner_auth_role: string | null;
}

export interface ManagedCredentialMigrationResult {
  scannedConnectorRows: number;
  convertedConnectorRows: number;
  pausedConnectorRows: number;
  scrubbedIdentityRows: number;
}

function providerIdentityNamesForConnector(connectorType: ConnectorType): string[] {
  if (connectorType === "outlook" || connectorType === "teams") return ["microsoft"];
  return [connectorType];
}

function statusAfterCanvasConversion(syncStatus: string): SyncStatus {
  if (syncStatus === "paused" || syncStatus === "disabled") return syncStatus;
  return "pending";
}

function statusAfterCanvasMigrationPause(syncStatus: string): SyncStatus {
  return syncStatus === "disabled" ? "disabled" : "paused";
}

function managedCanvasOAuthIdentityProviders(): string[] {
  return [...new Set(CANVAS_OAUTH_CONNECTOR_TYPES.flatMap(providerIdentityNamesForConnector))];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Canvas credential mint timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function listManagedLocalOAuthConnectorRows(db: Kysely<DB>): Promise<ManagedLocalOAuthConnectorRow[]> {
  return db
    .selectFrom("connector_configs")
    .leftJoin("users", "users.id", "connector_configs.created_by")
    .select([
      "connector_configs.id as id",
      "connector_configs.connector_type as connector_type",
      "connector_configs.sync_status as sync_status",
      "connector_configs.created_by as created_by",
      "users.email as owner_email",
      "users.name as owner_name",
      "users.auth_role as owner_auth_role",
    ])
    .where("connector_configs.credential_source", "=", "local")
    .where("connector_configs.auth_type", "=", "oauth")
    .where("connector_configs.connector_type", "in", [...CANVAS_OAUTH_CONNECTOR_TYPES])
    .execute();
}

async function updateConnectorForCanvasCredentials(params: {
  db: Kysely<DB>;
  connectorId: string;
  status: SyncStatus;
  errorMessage: string | null;
  appConfig: ManagedCredentialMigrationConfig;
}) {
  await params.db
    .updateTable("connector_configs")
    .set({
      credential_source: "canvas",
      credentials: encodeSecretField(
        JSON.stringify(canvasOAuthPlaceholderCredentials()),
        params.appConfig.ENCRYPTION_KEY,
      ),
      sync_status: params.status,
      error_message: params.errorMessage,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", params.connectorId)
    .execute();
}

async function scrubManagedProviderIdentityTokens(db: Kysely<DB>): Promise<number> {
  const providers = managedCanvasOAuthIdentityProviders();
  const rows = await db
    .selectFrom("user_provider_identities")
    .select("id")
    .where("provider", "in", providers)
    .where((eb) => eb.or([eb("access_token", "is not", null), eb("refresh_token", "is not", null)]))
    .execute();

  if (rows.length === 0) return 0;

  await db
    .updateTable("user_provider_identities")
    .set({
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
    })
    .where(
      "id",
      "in",
      rows.map((row) => row.id),
    )
    .execute();

  return rows.length;
}

export async function migrateManagedConnectorCredentialsToCanvas(params: {
  db: Kysely<DB>;
  appConfig: ManagedCredentialMigrationConfig;
  logger: Logger;
  mintCredential?: (request: {
    connectorType: ConnectorType;
    userEmail: string | null;
    userName?: string | null;
    userOrgRole?: "admin" | "member";
  }) => Promise<ConnectorCredentials>;
}): Promise<ManagedCredentialMigrationResult> {
  if (!isCanvasCredentialMode(params.appConfig)) {
    return {
      scannedConnectorRows: 0,
      convertedConnectorRows: 0,
      pausedConnectorRows: 0,
      scrubbedIdentityRows: 0,
    };
  }

  const canvasCredentialProvider = new CanvasConnectorCredentialProvider({
    db: params.db,
    appConfig: params.appConfig,
    logger: params.logger,
  });
  const mintCredential = params.mintCredential ?? ((request) => canvasCredentialProvider.mint(request));
  const rows = await listManagedLocalOAuthConnectorRows(params.db);

  let convertedConnectorRows = 0;
  let pausedConnectorRows = 0;

  for (const row of rows) {
    const connectorType = row.connector_type as ConnectorType;

    try {
      const minted = await withTimeout(
        mintCredential({
          connectorType,
          userEmail: row.owner_email,
          userName: row.owner_name,
          userOrgRole: row.owner_auth_role === "admin" ? "admin" : "member",
        }),
        MIGRATION_MINT_TIMEOUT_MS,
      );
      if (minted.type !== "oauth") {
        throw new Error("Canvas did not return OAuth credentials for managed OAuth connector");
      }
      await updateConnectorForCanvasCredentials({
        db: params.db,
        connectorId: row.id,
        status: statusAfterCanvasConversion(row.sync_status),
        errorMessage: null,
        appConfig: params.appConfig,
      });
      convertedConnectorRows += 1;
    } catch (err) {
      params.logger.warn(
        { err, connectorId: row.id, connectorType },
        "Managed Canvas credential migration paused a local OAuth connector",
      );
      await updateConnectorForCanvasCredentials({
        db: params.db,
        connectorId: row.id,
        status: statusAfterCanvasMigrationPause(row.sync_status),
        errorMessage: "Reconnect this integration through Canvas to resume sync",
        appConfig: params.appConfig,
      });
      pausedConnectorRows += 1;
    }
  }

  const scrubbedIdentityRows = await scrubManagedProviderIdentityTokens(params.db);

  if (rows.length > 0 || scrubbedIdentityRows > 0) {
    params.logger.info(
      {
        scannedConnectorRows: rows.length,
        convertedConnectorRows,
        pausedConnectorRows,
        scrubbedIdentityRows,
      },
      "Reconciled managed Canvas connector credentials",
    );
  }

  return {
    scannedConnectorRows: rows.length,
    convertedConnectorRows,
    pausedConnectorRows,
    scrubbedIdentityRows,
  };
}
