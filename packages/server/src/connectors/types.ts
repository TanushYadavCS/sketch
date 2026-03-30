/**
 * Core types for the connector system.
 *
 * Connectors pull data from external sources (Google Drive, ClickUp, Notion, Linear)
 * into Sketch's local index. Two content categories:
 * - "document": full content stored locally (docs, pages, PRDs)
 * - "structured": metadata only, live-fetched when needed (tasks, issues)
 */
import type { Logger } from "pino";

export type ConnectorType = "google_drive" | "clickup" | "notion" | "linear";

export type AuthType = "oauth" | "api_key" | "service_account";

export type SyncStatus = "pending" | "active" | "syncing" | "paused" | "error";

export type ContentCategory = "document" | "structured";

/**
 * Decrypted credentials stored per connector.
 * Shape varies by provider + auth type.
 */
export interface OAuthCredentials {
  type: "oauth";
  /** Initially empty — populated on first token refresh. */
  access_token: string;
  refresh_token: string;
  token_type?: string;
  /** ISO timestamp. Missing or empty = treat as expired → triggers refresh. */
  expires_at?: string;
  client_id: string;
  client_secret: string;
}

export interface ApiKeyCredentials {
  type: "api_key";
  api_key: string;
}

export interface ServiceAccountCredentials {
  type: "service_account";
  service_account_json: string;
}

export type ConnectorCredentials = OAuthCredentials | ApiKeyCredentials | ServiceAccountCredentials;

/**
 * A file/item discovered during sync that should be indexed.
 */
export interface SyncedItem {
  providerFileId: string;
  providerUrl: string | null;
  fileName: string;
  fileType: string | null;
  contentCategory: ContentCategory;
  content: string | null;
  sourcePath: string | null;
  contentHash: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  /** MIME type of the original file (e.g. "image/png", "application/pdf"). */
  mimeType?: string;
  /**
   * Scope-level access: assigns all files in a container (workspace, space, drive)
   * to a shared member list. Stored once per scope, referenced by many files.
   * Mutually exclusive with accessEmails for a given item.
   *
   * Used by: ClickUp (workspace/space), Google Drive (shared drives).
   */
  accessScope?: {
    scopeType: string;
    providerScopeId: string;
    label: string;
    memberEmails: string[];
  };
  /**
   * Per-file email access list. Used when access varies per file
   * (e.g., Google Drive My Drive files with individual sharing).
   * null → no per-file restrictions.
   */
  accessEmails?: string[] | null;
  /**
   * Structured assignee data for deterministic entity linking.
   * Each assignee is matched to a person entity and linked via entity_mentions.
   */
  assignees?: Array<{ name: string; email?: string }>;
}

/**
 * Result of a sync run.
 */
export interface SyncResult {
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsArchived: number;
  newCursor: string | null;
  errors: Array<{ fileId: string; error: string }>;
}

/**
 * Entity seed data emitted by connectors during sync.
 * Used to create entities from structural objects (spaces, folders, projects)
 * and people (assignees, attendees) without creating indexed_files.
 */
export interface EntitySeed {
  name: string;
  sourceType: string;
  source: string;
  sourceId: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface PersonEntitySeed {
  name: string;
  email?: string;
  subtype: "internal" | "external";
  source: string;
  sourceId: string;
}

export type EntitySeedCallback = (seed: EntitySeed) => Promise<void>;
export type PersonEntitySeedCallback = (seed: PersonEntitySeed) => Promise<void>;

/**
 * Base interface all connectors must implement.
 */
export interface Connector {
  readonly type: ConnectorType;

  /** Validate credentials work (test API call). */
  validateCredentials(credentials: ConnectorCredentials): Promise<void>;

  /** Run initial or incremental sync. Returns items to index. */
  sync(opts: {
    credentials: ConnectorCredentials;
    scopeConfig: Record<string, unknown>;
    cursor: string | null;
    logger: Logger;
    onEntitySeed?: EntitySeedCallback;
    onPersonSeed?: PersonEntitySeedCallback;
  }): AsyncGenerator<SyncedItem>;

  /** Return the new sync cursor after a sync run. */
  getCursor(opts: {
    credentials: ConnectorCredentials;
    scopeConfig: Record<string, unknown>;
    currentCursor: string | null;
    logger: Logger;
  }): Promise<string | null>;

  /**
   * Refresh OAuth tokens if needed.
   * Returns updated credentials or null if no refresh needed.
   */
  refreshTokens?(credentials: OAuthCredentials): Promise<OAuthCredentials | null>;
}
