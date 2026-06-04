/**
 * Core types for the connector system.
 *
 * Connectors pull data from external sources (Google Drive, ClickUp, Notion, Linear)
 * into Sketch's local index. Two content categories:
 * - "document": full content stored locally (docs, pages, PRDs)
 * - "structured": metadata only, live-fetched when needed (tasks, issues)
 */
import type { Logger } from "pino";

export type ConnectorType = "google_drive" | "gmail" | "clickup" | "notion" | "linear" | "fireflies";

export type AuthType = "oauth" | "api_key" | "service_account";

export type SyncStatus = "pending" | "active" | "syncing" | "paused" | "error" | "disabled";

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
  providerMessageId?: string;
  threadId?: string;
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
  /**
   * People meaningfully attached to this item (meeting speakers, doc authors).
   * Sync seeds person entities from entries where `name` is present; entries
   * with only `email` are ignored — `accessEmails` already covers ACL.
   */
  attendees?: Array<{ name?: string; email?: string }>;
  authorEmail?: string;
  authorName?: string;
  authorSourceId?: string;
  /**
   * Parent structural entities this item belongs to (e.g., ClickUp folder/space,
   * Google Drive folder). Linked via entity_mentions during sync.
   * `source` + `sourceId` are used to look up the entity.
   */
  parentEntities?: Array<{ source: string; sourceId: string; contextSnippet?: string }>;
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

export type IndexedFileFactRaw =
  | { providerFileId: string; attendee: { name?: string; email?: string } }
  | { providerFileId: string; correspondent: { name?: string; email?: string; sourceId?: string } }
  | { providerFileId: string; assignee: { name: string; email?: string }; sourceRefKey: string }
  | { providerFileId: string; author: { name?: string; email?: string; sourceId?: string } }
  | { providerFileId: string; parent: { source: string; sourceId: string; contextSnippet?: string } }
  | { sourceType: string; sourceUrl?: string; sourcePath?: string; metadata?: Record<string, unknown> }
  | { subtype: "internal" | "external" }
  | EntitySeed
  | PersonEntitySeed
  | {
      contentHash: string;
      promptVersion: string;
      model: string;
      mention: string;
      type: string;
      variations: string[];
      confidence?: number;
    }
  | {
      contentHash: string;
      promptVersion: string;
      model: string;
      relationType: string;
      confidence: number;
      sourceConfidence?: number;
      targetConfidence?: number;
      context?: string;
      source: { name: string; type: string; variations: string[] };
      target: { name: string; type: string; variations: string[] };
    }
  | {
      providerFileId: string;
      providerUrl?: string | null;
      fileType: string;
      sourcePath?: string | null;
    };

/**
 * Result of resolving a speaker / attendee name against Sketch-side state
 * (users table, person entities). Carries the resolved entity id and the
 * source map so downstream code (alias-confirmation backfill, logs, tests)
 * can distinguish recovery paths without redoing the lookup.
 */
export interface NameResolution {
  email: string;
  /** Present when resolution went through the entities map. */
  entityId?: string;
  /**
   * Provenance of the resolution. `"users"` means the Sketch users table
   * (team directory, canonical); `"entities"` means the broader person
   * entity register (seeded by any connector).
   */
  source: "users" | "entities";
}

/**
 * Resolve a speaker / attendee name to an existing identity in Sketch.
 * Returns null when no unambiguous match is found.
 *
 * Built once per sync run by the dispatcher; passed to connectors that
 * need to attribute names to people without a per-meeting roster (today:
 * Fireflies). Connectors that don't need it leave the field unset.
 */
export type NameResolver = (name: string) => NameResolution | null;

export interface SuppressedEmailRecord {
  providerFileId: string;
  providerMessageId?: string | null;
  threadId?: string | null;
  reason: string;
}

/**
 * Base interface all connectors must implement.
 */
export interface Connector {
  readonly type: ConnectorType;

  /**
   * Whether each user holds their own credential row in connector_configs.
   * true  = per-user (any authenticated user can create their own; one row per user)
   * false = org-wide (a single shared credential drives sync for everyone; admin-only)
   */
  readonly perUserAuth: boolean;

  /**
   * Whether an admin must populate provider Client ID/Secret in `settings`
   * before any user can authorize. Used to surface a "Ask your admin to
   * configure X first" empty state. Currently only Google Drive.
   */
  readonly requiresOAuthClientSetup: boolean;

  /**
   * File types that should be promoted to entities during sync.
   * e.g. Linear returns ["project"] — synced Linear projects become entities.
   * Connectors that seed entities directly via onEntitySeed (e.g. Notion) leave this empty.
   */
  readonly promotableFileTypes?: string[];

  /**
   * Whether this connector's people are email correspondents rather than meeting
   * attendees / document authors. When true, `attendees` and `authorEmail` seed
   * `correspondent`/`corresponded` person facts instead of `attendee`/`author`.
   * Email connectors (Gmail, Outlook) set this; everything else leaves it false.
   */
  readonly emitsCorrespondentFacts?: boolean;

  /**
   * Build the source ref key for an assignee (used to match against person entities).
   * Default: `{connectorType}:user:{name}`. Override for connectors with
   * different conventions (e.g. ClickUp uses `clickup:assignee:{name}`).
   */
  assigneeSourceRefKey?(assigneeName: string): string;

  /** Validate credentials work (test API call). */
  validateCredentials(credentials: ConnectorCredentials): Promise<void>;

  /** Run initial or incremental sync. Returns items to index. */
  sync(opts: {
    connectorConfigId?: string;
    credentials: ConnectorCredentials;
    scopeConfig: Record<string, unknown>;
    cursor: string | null;
    logger: Logger;
    /**
     * Sketch email of the user who owns this connector config. Used by
     * connectors whose upstream ACL may not include the owner (e.g. Fireflies
     * Zoom meetings where Fireflies returns only the bot account). Connectors
     * that don't need it ignore the field.
     */
    ownerEmail?: string | null;
    /**
     * Resolve a speaker / attendee name to a Sketch-side identity. Built
     * by the dispatcher from the users table + person entity register
     * (with alias flattening + ambiguity drop); see runConnectorSync.
     * Optional — connectors that don't need it leave it unset.
     */
    resolveNameToEmail?: NameResolver;
    onEntitySeed?: EntitySeedCallback;
    onPersonSeed?: PersonEntitySeedCallback;
    onEmailSuppressed?: (record: SuppressedEmailRecord) => Promise<void>;
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

  /**
   * Browse available scope items (workspaces, pages, drives, etc.).
   * Returns immediately for sync connectors, or a BrowseJob for async ones (e.g. Notion).
   * Optional — connectors without scope selection don't implement this.
   */
  browse?(opts: { credentials: ConnectorCredentials; logger: Logger }): Promise<BrowseResult | BrowseJob>;

  /**
   * Browse for an existing connector — always returns sync results.
   * Used by the manage dialog. If not implemented, falls back to browse().
   * Connectors with async browse (e.g. Notion) should implement this
   * to return results directly without starting a background job.
   */
  browseExisting?(opts: { credentials: ConnectorCredentials; logger: Logger }): Promise<BrowseResult>;

  /**
   * Browse folder/subtree contents for tree-type scope pickers (e.g. Google Drive).
   * Only needed for connectors with scopeType "tree".
   */
  browseChildren?(opts: {
    credentials: ConnectorCredentials;
    parentId: string;
    logger: Logger;
  }): Promise<BrowseTreeItem[]>;
}

// ── Browse types ──────────────────────────────────────────────────────────────

export interface BrowseFlatItem {
  id: string;
  name: string;
  url?: string;
}

export interface BrowseNestedGroup {
  id: string;
  name: string;
  items: BrowseFlatItem[];
}

export interface BrowseTreeItem {
  id: string;
  name: string;
  hasChildren?: boolean;
}

export type BrowseResult =
  | { type: "flat"; items: BrowseFlatItem[] }
  | { type: "nested"; groups: BrowseNestedGroup[] }
  | { type: "tree"; items: BrowseTreeItem[]; groups?: BrowseNestedGroup[] };

export interface BrowseJob {
  type: "async";
  jobId: string;
}
