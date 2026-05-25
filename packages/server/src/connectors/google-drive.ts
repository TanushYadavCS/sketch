/**
 * Google Drive connector.
 *
 * Uses the Drive v3 API via direct HTTP calls (no googleapis dependency).
 * Supports OAuth tokens — admin creates OAuth app, authenticates via browser,
 * Sketch stores refresh token.
 *
 * Sync strategy:
 * - Shared drives: list files per selected drive with drive-level permissions
 * - Initial: full crawl of selected shared drives
 * - Incremental: use changes.list with startPageToken cursor
 * - Google Workspace files exported as plain text (Docs, Sheets, Slides)
 * - Binary documents (PDF, DOCX, XLSX, PPTX) extracted via extractors module
 *
 * Access model:
 * - Permissions fetched at the shared drive level (one API call per drive)
 * - All files in a drive inherit the drive's member list
 * - Shared drives use access scopes (drive-level member lists)
 * - My Drive files use per-file permission emails
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { BINARY_EXTRACTABLE_MIMES, extractTextFromBinary } from "./extractors";
import type { BrowseTreeItem, Connector, ConnectorCredentials, OAuthCredentials, SyncedItem } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

/** Google Workspace MIME types and their export formats. */
const EXPORT_MIMES: Record<string, { exportMime: string; fileType: string }> = {
  "application/vnd.google-apps.document": { exportMime: "text/plain", fileType: "document" },
  "application/vnd.google-apps.spreadsheet": { exportMime: "text/csv", fileType: "spreadsheet" },
  "application/vnd.google-apps.presentation": { exportMime: "text/plain", fileType: "presentation" },
};

/** MIME types we can extract text content from. */
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "text/xml",
  "application/xml",
]);

/** Folder MIME type — used to skip folder entries in file listings. */
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Max content size: 5MB of text. */
const MAX_CONTENT_BYTES = 512 * 1024; // 512 KB — ~128K tokens, safe for LLM enrichment

/** Max file size to attempt download: 200MB. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** Files per page when listing. */
const PAGE_SIZE = 100;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
  permissions?: DrivePermission[];
  owners?: DriveOwner[];
}

interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
}

export interface SharedDriveInfo {
  id: string;
  name: string;
}

interface DrivePermission {
  emailAddress?: string;
  role: string;
  type: string;
  displayName?: string;
}

interface DriveOwner {
  displayName?: string;
  emailAddress?: string;
  permissionId?: string;
}

function assertOAuth(credentials: ConnectorCredentials): asserts credentials is OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Google Drive connector requires OAuth credentials");
  }
}

async function driveRequest(
  path: string,
  accessToken: string,
  opts?: { params?: Record<string, string>; responseType?: "json" | "text" | "buffer" },
  attempt = 1,
): Promise<unknown> {
  const url = new URL(`${DRIVE_API}${path}`);
  if (opts?.params) {
    for (const [key, value] of Object.entries(opts.params)) {
      url.searchParams.set(key, value);
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
    const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

    if (attempt < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return driveRequest(path, accessToken, opts, attempt + 1);
    }

    throw new Error(`Drive API ${path} network error after ${MAX_RETRIES} attempts: ${detail}`);
  }

  if (response.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Drive API ${path} rate-limited (429) after ${MAX_RETRIES} attempts`);
    }
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return driveRequest(path, accessToken, opts, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text();

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return driveRequest(path, accessToken, opts, attempt + 1);
    }

    // Surface a clear message for the most common OAuth scope issue
    if (response.status === 403 && body.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
      throw new Error(
        "Insufficient OAuth scope. The refresh token must be generated with the " +
          "https://www.googleapis.com/auth/drive.readonly scope. " +
          "Re-authorize in Google OAuth Playground with the correct scope and paste the new refresh token.",
      );
    }

    throw new Error(`Drive API ${path} failed (${response.status}): ${body}`);
  }

  if (opts?.responseType === "text") return response.text();
  if (opts?.responseType === "buffer") return response.arrayBuffer();
  return response.json();
}

async function refreshOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  return {
    ...credentials,
    access_token: data.access_token,
    token_type: data.token_type,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

function isTokenExpired(credentials: OAuthCredentials): boolean {
  if (!credentials.expires_at) return true;
  return new Date(credentials.expires_at).getTime() < Date.now() + 60_000;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function inferFileType(mimeType: string): string | null {
  if (mimeType.includes("document") || mimeType.includes("text")) return "document";
  if (mimeType.includes("spreadsheet") || mimeType.includes("csv")) return "spreadsheet";
  if (mimeType.includes("presentation")) return "presentation";
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("image")) return "image";
  if (mimeType.includes("video")) return "video";
  return null;
}

async function fetchFileContent(
  file: DriveFile,
  accessToken: string,
  logger: Logger,
): Promise<{ content: string; hash: string } | null> {
  try {
    // 1. Google Workspace files — export via Drive export API
    const exportInfo = EXPORT_MIMES[file.mimeType];

    if (exportInfo) {
      const text = (await driveRequest(`/files/${file.id}/export`, accessToken, {
        params: { mimeType: exportInfo.exportMime },
        responseType: "text",
      })) as string;

      return truncateAndHash(text, file, logger);
    }

    // 2. Native text files — download as text
    if (TEXT_MIMES.has(file.mimeType)) {
      const sizeBytes = file.size ? Number.parseInt(file.size, 10) : 0;
      if (sizeBytes > MAX_DOWNLOAD_BYTES) {
        logger.debug({ fileId: file.id, size: sizeBytes }, "Skipping download (too large)");
        return null;
      }

      const text = (await driveRequest(`/files/${file.id}`, accessToken, {
        params: { alt: "media", supportsAllDrives: "true" },
        responseType: "text",
      })) as string;

      return truncateAndHash(text, file, logger);
    }

    // 3. Binary documents (PDF, DOCX, XLSX, PPTX) — download as buffer, then extract
    if (BINARY_EXTRACTABLE_MIMES.has(file.mimeType)) {
      const sizeBytes = file.size ? Number.parseInt(file.size, 10) : 0;
      if (sizeBytes > MAX_DOWNLOAD_BYTES) {
        logger.debug({ fileId: file.id, size: sizeBytes }, "Skipping binary download (too large)");
        return null;
      }

      const buffer = (await driveRequest(`/files/${file.id}`, accessToken, {
        params: { alt: "media", supportsAllDrives: "true" },
        responseType: "buffer",
      })) as ArrayBuffer;

      const text = await extractTextFromBinary(buffer, file.mimeType, logger);
      if (!text) return null;

      return truncateAndHash(text, file, logger);
    }

    return null;
  } catch (err) {
    logger.warn({ err, fileId: file.id, fileName: file.name }, "Failed to fetch file content");
    return null;
  }
}

function truncateAndHash(text: string, file: DriveFile, logger: Logger): { content: string; hash: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.length > MAX_CONTENT_BYTES) {
    logger.debug({ fileId: file.id, fileName: file.name }, "Content truncated (too large)");
    const truncated = trimmed.slice(0, MAX_CONTENT_BYTES);
    return { content: truncated, hash: contentHash(truncated) };
  }

  return { content: trimmed, hash: contentHash(trimmed) };
}

/** Exported for testing. */
export function fileToSyncedItem(
  file: DriveFile,
  content: string | null,
  hash: string | null,
  sourcePath: string | null,
  access: { scope?: SyncedItem["accessScope"]; emails?: string[] | null },
): SyncedItem {
  const exportInfo = EXPORT_MIMES[file.mimeType];

  return {
    providerFileId: file.id,
    providerUrl: file.webViewLink ?? null,
    fileName: file.name,
    fileType: exportInfo?.fileType ?? inferFileType(file.mimeType),
    contentCategory: content ? "document" : "structured",
    content,
    sourcePath,
    contentHash: hash,
    sourceCreatedAt: file.createdTime ?? null,
    sourceUpdatedAt: file.modifiedTime ?? null,
    mimeType: file.mimeType,
    accessScope: access.scope,
    accessEmails: access.emails,
    authorEmail: file.owners?.find((owner) => owner.emailAddress)?.emailAddress,
    authorName: file.owners?.find((owner) => owner.emailAddress)?.displayName,
    authorSourceId: file.owners?.find((owner) => owner.emailAddress)?.permissionId,
  };
}

/* ── Exported helpers for the browse API ─────────────── */

/**
 * Ensure we have a valid access token, refreshing if needed.
 * Exported so the browse API can prepare credentials before calling listSharedDrives.
 */
export async function ensureValidToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  if (isTokenExpired(credentials)) {
    return refreshOAuthToken(credentials);
  }
  return credentials;
}

/**
 * List all shared drives the authenticated user has access to.
 * Used by the browse API for the drive picker.
 */
export async function listSharedDrives(accessToken: string): Promise<SharedDriveInfo[]> {
  const drives: SharedDriveInfo[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = { pageSize: "100" };
    if (pageToken) params.pageToken = pageToken;

    const result = (await driveRequest("/drives", accessToken, { params })) as {
      drives?: Array<{ id: string; name: string }>;
      nextPageToken?: string;
    };

    for (const drive of result.drives ?? []) {
      drives.push({ id: drive.id, name: drive.name });
    }

    pageToken = result.nextPageToken;
  } while (pageToken);

  return drives.sort((a, b) => a.name.localeCompare(b.name));
}

export interface FolderInfo {
  id: string;
  name: string;
}

export interface FolderContentItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
}

const SAFE_FOLDER_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * List immediate children of a folder (files and subfolders).
 * Used by the browse API to let users preview folder contents before syncing.
 */
export async function listFolderContents(accessToken: string, folderId: string): Promise<FolderContentItem[]> {
  if (!SAFE_FOLDER_ID.test(folderId)) {
    throw new Error(`Invalid folderId: "${folderId}" contains characters not allowed in a Drive folder ID`);
  }

  const items: FolderContentItem[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "100",
      orderBy: "folder,name",
    };
    if (pageToken) params.pageToken = pageToken;

    const result = (await driveRequest("/files", accessToken, { params })) as {
      files?: Array<{ id: string; name: string; mimeType: string }>;
      nextPageToken?: string;
    };

    for (const file of result.files ?? []) {
      items.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        isFolder: file.mimeType === FOLDER_MIME,
      });
    }

    pageToken = result.nextPageToken;
  } while (pageToken);

  return items;
}

/**
 * List top-level folders in the user's My Drive.
 * Used by the browse API for the folder picker when no shared drives exist.
 */
export async function listMyDriveFolders(accessToken: string): Promise<FolderInfo[]> {
  const folders: FolderInfo[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      q: `'root' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: "100",
      orderBy: "name",
    };
    if (pageToken) params.pageToken = pageToken;

    const result = (await driveRequest("/files", accessToken, { params })) as {
      files?: Array<{ id: string; name: string }>;
      nextPageToken?: string;
    };

    for (const file of result.files ?? []) {
      folders.push({ id: file.id, name: file.name });
    }

    pageToken = result.nextPageToken;
  } while (pageToken);

  return folders;
}

/**
 * Fetch members of a shared drive.
 * Returns email addresses of all users with access.
 */
async function fetchDriveMemberEmails(driveId: string, accessToken: string, logger: Logger): Promise<string[]> {
  const emails: string[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      fields: "nextPageToken, permissions(emailAddress, role, type, displayName)",
      pageSize: "100",
      supportsAllDrives: "true",
    };
    if (pageToken) params.pageToken = pageToken;

    const result = (await driveRequest(`/files/${driveId}/permissions`, accessToken, { params })) as {
      permissions?: DrivePermission[];
      nextPageToken?: string;
    };

    for (const perm of result.permissions ?? []) {
      if (perm.type === "user" && perm.emailAddress) {
        emails.push(perm.emailAddress);
      }
    }

    pageToken = result.nextPageToken;
  } while (pageToken);

  logger.debug({ driveId, memberCount: emails.length }, "Fetched drive members");
  return emails;
}

/**
 * Extract per-file permission emails from the inline permissions list.
 * Used for My Drive files where permissions are per-file (not drive-level).
 */
function extractFilePermissionEmails(file: DriveFile): string[] {
  const emails: string[] = [];
  for (const perm of file.permissions ?? []) {
    if (perm.type === "user" && perm.emailAddress) {
      emails.push(perm.emailAddress);
    }
  }
  return emails;
}

/**
 * Resolve folder ID → name for building sourcePath.
 * Caches results to avoid repeated lookups.
 * Exported for testing.
 */
export async function resolveFolderPath(
  file: DriveFile,
  driveName: string,
  accessToken: string,
  folderCache: Map<string, string>,
): Promise<string> {
  const parts: string[] = [driveName];

  if (!file.parents || file.parents.length === 0) {
    return driveName;
  }

  // Walk parent chain (usually 1-3 levels deep)
  let currentParentId = file.parents[0];
  const chain: string[] = [];
  const MAX_FOLDER_DEPTH = 20;
  let depth = 0;

  while (currentParentId && depth < MAX_FOLDER_DEPTH) {
    depth++;
    // Check cache first
    if (folderCache.has(currentParentId)) {
      const cached = folderCache.get(currentParentId);
      if (!cached || cached === "__root__") break;
      chain.unshift(cached);
      break;
    }

    try {
      const folder = (await driveRequest(`/files/${currentParentId}`, accessToken, {
        params: { fields: "id, name, parents", supportsAllDrives: "true" },
      })) as { id: string; name: string; parents?: string[] };

      // If this folder's parent is the drive root, we're done
      if (!folder.parents || folder.parents.length === 0) {
        folderCache.set(currentParentId, "__root__");
        break;
      }

      chain.unshift(folder.name);
      folderCache.set(currentParentId, folder.name);
      currentParentId = folder.parents[0];
    } catch {
      // If we can't resolve a parent, stop here
      folderCache.set(currentParentId, "__root__");
      break;
    }
  }

  parts.push(...chain);
  return parts.join(" / ");
}

/* ── Connector implementation ────────────────────────── */

export function createGoogleDriveConnector(): Connector {
  return {
    type: "google_drive",
    perUserAuth: true,
    requiresOAuthClientSetup: true,

    async validateCredentials(credentials) {
      assertOAuth(credentials);
      let creds = credentials;
      if (isTokenExpired(creds)) {
        creds = await refreshOAuthToken(creds);
      }
      await driveRequest("/about", creds.access_token, {
        params: { fields: "user" },
      });
    },

    async *sync({ credentials, scopeConfig, cursor, logger }) {
      assertOAuth(credentials);
      let creds = credentials;
      if (isTokenExpired(creds)) {
        creds = await refreshOAuthToken(creds);
      }

      const sharedDrives = (scopeConfig.sharedDrives as string[] | undefined) ?? [];
      const myDriveFolders = (scopeConfig.folders as string[] | undefined) ?? [];

      // Sync selected shared drives
      for (const driveId of sharedDrives) {
        if (cursor) {
          yield* syncIncrementalDrive(creds.access_token, driveId, cursor, logger);
        } else {
          yield* syncSharedDrive(creds.access_token, driveId, logger);
        }
      }

      // Sync My Drive folders (or all files if neither shared drives nor folders selected)
      if (myDriveFolders.length > 0 || sharedDrives.length === 0) {
        if (cursor) {
          yield* syncIncremental(creds.access_token, cursor, logger);
        } else {
          yield* syncFull(creds.access_token, scopeConfig, logger);
        }
      }
    },

    async getCursor({ credentials, currentCursor, logger }) {
      assertOAuth(credentials);
      let creds = credentials;
      if (isTokenExpired(creds)) {
        creds = await refreshOAuthToken(creds);
      }

      if (currentCursor) {
        return currentCursor;
      }

      const result = (await driveRequest("/changes/startPageToken", creds.access_token, {
        params: { supportsAllDrives: "true" },
      })) as {
        startPageToken: string;
      };
      logger.debug({ startPageToken: result.startPageToken }, "Got initial startPageToken");
      return result.startPageToken;
    },

    async refreshTokens(credentials) {
      if (isTokenExpired(credentials)) {
        return refreshOAuthToken(credentials);
      }
      return null;
    },

    async browse({ credentials }) {
      const validCreds = await ensureValidToken(credentials as OAuthCredentials);
      const sharedDrives = await listSharedDrives(validCreds.access_token);
      const rootFolders = await listMyDriveFolders(validCreds.access_token);
      return {
        type: "tree" as const,
        items: rootFolders.map((f) => ({ id: f.id, name: f.name, hasChildren: true })),
        groups:
          sharedDrives.length > 0
            ? [
                {
                  id: "shared-drives",
                  name: "Shared Drives",
                  items: sharedDrives.map((d) => ({ id: d.id, name: d.name })),
                },
              ]
            : undefined,
      };
    },

    async browseChildren({ credentials, parentId }) {
      const validCreds = await ensureValidToken(credentials as OAuthCredentials);
      const items = await listFolderContents(validCreds.access_token, parentId);
      return items
        .filter((i) => i.mimeType === "application/vnd.google-apps.folder")
        .map((i): BrowseTreeItem => ({ id: i.id, name: i.name, hasChildren: true }));
    },
  };
}

/* ── Shared drive sync ──────────────────────────────── */

/**
 * Full sync for a single shared drive:
 * 1. Fetch drive name + members (permissions)
 * 2. List all files in the drive
 * 3. Resolve folder paths for each file
 * 4. Yield SyncedItem with access info
 */
async function* syncSharedDrive(accessToken: string, driveId: string, logger: Logger): AsyncGenerator<SyncedItem> {
  // Get drive name
  const driveInfo = (await driveRequest(`/drives/${driveId}`, accessToken, {
    params: { fields: "id, name" },
  })) as { id: string; name: string };
  const driveName = driveInfo.name;

  // Get drive members for scope-level access control (may fail with readonly scope — non-fatal)
  let driveScope: SyncedItem["accessScope"] | undefined;
  try {
    const memberEmails = await fetchDriveMemberEmails(driveId, accessToken, logger);
    if (memberEmails.length > 0) {
      driveScope = { scopeType: "drive", providerScopeId: driveId, label: driveName, memberEmails };
    }
  } catch (err) {
    logger.warn(
      { driveId, err },
      "Could not fetch drive members (permissions API may require full drive scope) — continuing without access metadata",
    );
  }
  logger.info({ driveId, driveName, memberCount: driveScope?.memberEmails.length ?? 0 }, "Syncing shared drive");

  // Cache for folder path resolution
  const folderCache = new Map<string, string>();

  const fields =
    "nextPageToken, files(id, name, mimeType, webViewLink, parents, createdTime, modifiedTime, size, trashed, owners(displayName,emailAddress,permissionId))";

  let pageToken: string | undefined;
  let totalFiles = 0;

  do {
    const params: Record<string, string> = {
      q: "trashed = false",
      fields,
      pageSize: String(PAGE_SIZE),
      orderBy: "modifiedTime desc",
      corpora: "drive",
      driveId,
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    };
    if (pageToken) params.pageToken = pageToken;

    const result = (await driveRequest("/files", accessToken, { params })) as {
      files: DriveFile[];
      nextPageToken?: string;
    };

    for (const file of result.files) {
      if (file.mimeType === FOLDER_MIME) continue;

      const fetched = await fetchFileContent(file, accessToken, logger);
      const sourcePath = await resolveFolderPath(file, driveName, accessToken, folderCache);
      yield fileToSyncedItem(file, fetched?.content ?? null, fetched?.hash ?? null, sourcePath, { scope: driveScope });
      totalFiles++;
    }

    pageToken = result.nextPageToken;
    logger.debug({ driveId, driveName, filesProcessed: totalFiles, hasMore: !!pageToken }, "Drive sync page");
  } while (pageToken);

  logger.info({ driveId, driveName, totalFiles }, "Shared drive sync complete");
}

/**
 * Incremental sync for a shared drive using changes.list.
 */
async function* syncIncrementalDrive(
  accessToken: string,
  driveId: string,
  startPageToken: string,
  logger: Logger,
): AsyncGenerator<SyncedItem> {
  // Get drive info + members for scope-level access on changed files
  const driveInfo = (await driveRequest(`/drives/${driveId}`, accessToken, {
    params: { fields: "id, name" },
  })) as { id: string; name: string };
  const driveName = driveInfo.name;
  let driveScope: SyncedItem["accessScope"] | undefined;
  try {
    const memberEmails = await fetchDriveMemberEmails(driveId, accessToken, logger);
    if (memberEmails.length > 0) {
      driveScope = { scopeType: "drive", providerScopeId: driveId, label: driveName, memberEmails };
    }
  } catch (err) {
    logger.warn({ driveId, err }, "Could not fetch drive members — continuing without access metadata");
  }

  const folderCache = new Map<string, string>();
  const fields =
    "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, webViewLink, parents, createdTime, modifiedTime, size, trashed, owners(displayName,emailAddress,permissionId)))";

  let pageToken = startPageToken;
  let totalChanges = 0;

  while (pageToken) {
    const result = (await driveRequest("/changes", accessToken, {
      params: {
        pageToken,
        fields,
        pageSize: String(PAGE_SIZE),
        driveId,
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      },
    })) as {
      changes: DriveChange[];
      nextPageToken?: string;
      newStartPageToken?: string;
    };

    for (const change of result.changes) {
      if (change.removed || !change.file || change.file.trashed) {
        yield {
          providerFileId: change.fileId,
          providerUrl: null,
          fileName: "",
          fileType: null,
          contentCategory: "structured",
          content: null,
          sourcePath: null,
          contentHash: null,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        };
        totalChanges++;
        continue;
      }

      if (change.file.mimeType === FOLDER_MIME) continue;

      const fetched = await fetchFileContent(change.file, accessToken, logger);
      const sourcePath = await resolveFolderPath(change.file, driveName, accessToken, folderCache);
      yield fileToSyncedItem(change.file, fetched?.content ?? null, fetched?.hash ?? null, sourcePath, {
        scope: driveScope,
      });
      totalChanges++;
    }

    pageToken = result.nextPageToken ?? "";
    if (result.newStartPageToken) {
      pageToken = "";
    }

    logger.debug({ driveId, changesProcessed: totalChanges, hasMore: !!pageToken }, "Changes page complete");
  }

  logger.info({ driveId, driveName, totalChanges }, "Incremental drive sync complete");
}

/* ── My Drive sync (non-shared-drive mode) ────────────── */

/**
 * Full sync for My Drive mode.
 * When folders are specified, recursively syncs all files in those folder trees.
 * When no folders specified, syncs all accessible files.
 */
async function* syncFull(
  accessToken: string,
  scopeConfig: Record<string, unknown>,
  logger: Logger,
): AsyncGenerator<SyncedItem> {
  const folders = (scopeConfig.folders as string[] | undefined) ?? [];

  if (folders.length > 0) {
    yield* syncSelectedFolders(accessToken, folders, logger);
  } else {
    yield* syncAllFiles(accessToken, logger);
  }
}

/**
 * Recursively sync all files within selected folders.
 * Walks the folder tree breadth-first to find all nested files.
 * Resolves folder paths and extracts per-file permissions.
 */
async function* syncSelectedFolders(
  accessToken: string,
  folderIds: string[],
  logger: Logger,
): AsyncGenerator<SyncedItem> {
  const fields =
    "nextPageToken, files(id, name, mimeType, webViewLink, parents, createdTime, modifiedTime, size, trashed, owners(displayName,emailAddress,permissionId), permissions(emailAddress, role, type, displayName))";

  const folderCache = new Map<string, string>();
  const visited = new Set<string>();
  const queue = [...folderIds];
  let totalFiles = 0;

  while (queue.length > 0) {
    const folderId = queue.shift() as string;
    if (visited.has(folderId)) continue;
    visited.add(folderId);

    logger.info({ folderId, folderQueue: queue.length, visited: visited.size, totalFiles }, "Syncing folder");

    let pageToken: string | undefined;

    do {
      const params: Record<string, string> = {
        q: `'${folderId}' in parents and trashed = false`,
        fields,
        pageSize: String(PAGE_SIZE),
      };
      if (pageToken) params.pageToken = pageToken;

      const result = (await driveRequest("/files", accessToken, { params })) as {
        files: DriveFile[];
        nextPageToken?: string;
      };

      for (const file of result.files) {
        if (file.mimeType === FOLDER_MIME) {
          queue.push(file.id);
          continue;
        }
        const fetched = await fetchFileContent(file, accessToken, logger);
        const sourcePath = await resolveFolderPath(file, "My Drive", accessToken, folderCache);
        const permissionEmails = extractFilePermissionEmails(file);
        yield fileToSyncedItem(file, fetched?.content ?? null, fetched?.hash ?? null, sourcePath, {
          emails: permissionEmails.length > 0 ? permissionEmails : null,
        });
        totalFiles++;
      }

      pageToken = result.nextPageToken;
      logger.debug({ folderId, filesProcessed: totalFiles, hasMore: !!pageToken }, "Folder sync page");
    } while (pageToken);
  }

  logger.info({ totalFiles, folderCount: visited.size }, "Folder sync complete");
}

/** Sync all accessible files (no folder filter). Resolves folder paths and extracts per-file permissions. */
async function* syncAllFiles(accessToken: string, logger: Logger): AsyncGenerator<SyncedItem> {
  const fields =
    "nextPageToken, files(id, name, mimeType, webViewLink, parents, createdTime, modifiedTime, size, trashed, owners(displayName,emailAddress,permissionId), permissions(emailAddress, role, type, displayName))";

  const folderCache = new Map<string, string>();
  let pageToken: string | undefined;
  let totalFiles = 0;

  do {
    const params: Record<string, string> = {
      q: "trashed = false",
      fields,
      pageSize: String(PAGE_SIZE),
      orderBy: "modifiedTime desc",
    };
    if (pageToken) params.pageToken = pageToken;

    const result = (await driveRequest("/files", accessToken, { params })) as {
      files: DriveFile[];
      nextPageToken?: string;
    };

    for (const file of result.files) {
      if (file.mimeType === FOLDER_MIME) continue;
      const fetched = await fetchFileContent(file, accessToken, logger);
      const sourcePath = await resolveFolderPath(file, "My Drive", accessToken, folderCache);
      const permissionEmails = extractFilePermissionEmails(file);
      yield fileToSyncedItem(file, fetched?.content ?? null, fetched?.hash ?? null, sourcePath, {
        emails: permissionEmails.length > 0 ? permissionEmails : null,
      });
      totalFiles++;
    }

    pageToken = result.nextPageToken;
    logger.debug({ filesProcessed: totalFiles, hasMore: !!pageToken }, "Sync page complete");
  } while (pageToken);

  logger.info({ totalFiles }, "Full sync complete");
}

async function* syncIncremental(
  accessToken: string,
  startPageToken: string,
  logger: Logger,
): AsyncGenerator<SyncedItem> {
  const fields =
    "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, webViewLink, parents, createdTime, modifiedTime, size, trashed, owners(displayName,emailAddress,permissionId), permissions(emailAddress, role, type, displayName)))";

  const folderCache = new Map<string, string>();
  let pageToken = startPageToken;
  let totalChanges = 0;

  while (pageToken) {
    const result = (await driveRequest("/changes", accessToken, {
      params: {
        pageToken,
        fields,
        pageSize: String(PAGE_SIZE),
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      },
    })) as {
      changes: DriveChange[];
      nextPageToken?: string;
      newStartPageToken?: string;
    };

    for (const change of result.changes) {
      if (change.removed || !change.file || change.file.trashed) {
        yield {
          providerFileId: change.fileId,
          providerUrl: null,
          fileName: "",
          fileType: null,
          contentCategory: "structured",
          content: null,
          sourcePath: null,
          contentHash: null,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        };
        totalChanges++;
        continue;
      }

      if (change.file.mimeType === FOLDER_MIME) continue;

      const fetched = await fetchFileContent(change.file, accessToken, logger);
      const sourcePath = await resolveFolderPath(change.file, "My Drive", accessToken, folderCache);
      const permissionEmails = extractFilePermissionEmails(change.file);
      yield fileToSyncedItem(change.file, fetched?.content ?? null, fetched?.hash ?? null, sourcePath, {
        emails: permissionEmails.length > 0 ? permissionEmails : null,
      });
      totalChanges++;
    }

    pageToken = result.nextPageToken ?? "";
    if (result.newStartPageToken) {
      pageToken = "";
    }

    logger.debug({ changesProcessed: totalChanges, hasMore: !!pageToken }, "Changes page complete");
  }

  logger.info({ totalChanges }, "Incremental sync complete");
}
