/**
 * Notion connector (V2).
 *
 * Uses the Notion REST API v1 (2022-06-28) via direct HTTP calls.
 * Auth: Internal integration token or OAuth.
 *
 * Sync strategy (4-phase):
 * 1. Discover workspace members → seed person entities
 * 2. Walk page tree via /search → build hierarchy map, seed page entities
 * 3. Sync databases: classify as table vs content-collection, generate
 *    rich descriptions (headers + sample rows), index content-collection
 *    rows as documents with block content
 * 4. Sync standalone pages (non-database) with block content as documents
 *
 * Rate limit: 3 req/s (Notion's published limit).
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type {
  Connector,
  ConnectorCredentials,
  EntitySeedCallback,
  OAuthCredentials,
  PersonEntitySeedCallback,
  SyncedItem,
} from "./types";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const TOKEN_ENDPOINT = "https://api.notion.com/v1/oauth/token";

const RATE_LIMIT_REQUESTS = 3;
const RATE_LIMIT_PERIOD_MS = 1000;
const PAGE_SIZE = 100;
const MAX_BLOCK_DEPTH = 5;

/** Number of database rows to sample when classifying table vs content-collection. */
const DB_SAMPLE_SIZE = 3;
/** Number of sample rows to include in database description. */
const DB_DESCRIPTION_ROWS = 5;

/**
 * Generic database names that describe a format/category rather than a specific thing.
 * These are still indexed as files (with rich descriptions) but NOT promoted to entities,
 * because "Tasks" × 11 from different teamspaces is noise in the entity explorer.
 * Distinctive names like "Sales CRM" or "Habuild Sprint Tasks" become entities.
 */
const GENERIC_DB_NAMES = new Set([
  // Task/project management
  "tasks",
  "projects",
  "sprints",
  "board",
  "scrum board",
  "kanban",
  "kanban board",
  "backlog",
  "bugs",
  "issues",
  "action items",
  "actions",
  "to-do",
  "to-dos",
  "todos",
  "tracker",
  "timeline",
  "milestones",
  "epics",
  "stories",
  "tickets",
  "requests",
  "queue",
  // Docs/knowledge
  "docs",
  "documents",
  "notes",
  "wiki",
  "resources",
  "references",
  "archive",
  "archives",
  "templates",
  "guides",
  "faqs",
  "help",
  // People/CRM
  "contacts",
  "leads",
  "companies",
  "people",
  "team members",
  "members",
  "directory",
  "employees",
  "clients",
  "customers",
  "accounts",
  "vendors",
  "partners",
  "stakeholders",
  "prospects",
  "outbound",
  "mutual connections",
  "pipeline",
  // Meetings/comms
  "meetings",
  "meeting notes",
  "agenda",
  "agendas",
  "standup",
  "standups",
  "retro",
  "retrospectives",
  "decisions",
  "recent decisions",
  "minutes",
  "updates",
  "announcements",
  "changelog",
  // Planning/strategy
  "okrs",
  "goals",
  "kpis",
  "metrics",
  "roadmap",
  "initiatives",
  "priorities",
  "prioritized ideas",
  "ideas",
  "feedback",
  "feature requests",
  "proposals",
  "experiments",
  // Content
  "content table",
  "content calendar",
  "calendar",
  "schedule",
  "events",
  "posts",
  "blog",
  "articles",
  // Meta/system
  "all dbs",
  "untitled database",
  "untitled",
  "apps",
  "alerts",
  "logs",
  "inventory",
  "database",
  "table",
  // HR/ops
  "applications",
  "interviews",
  "onboarding",
  "expenses",
  "assets",
  "policies",
  "processes",
  // Tech
  "tech tasks",
  "deployments",
  "incidents",
  "runbooks",
  "apis",
  "integrations",
  "configurations",
]);

function getAccessToken(credentials: ConnectorCredentials): string {
  if (credentials.type === "api_key") return credentials.api_key;
  if (credentials.type === "oauth") return credentials.access_token;
  throw new Error("Notion connector requires api_key or oauth credentials");
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Create per-connector-instance rate limiter and request helpers.
 * Keeps requestTimes in closure so concurrent connector syncs don't share state.
 */
function makeNotionRequests() {
  const requestTimes: number[] = [];

  async function waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_PERIOD_MS;
    while (requestTimes.length > 0 && requestTimes[0] < cutoff) {
      requestTimes.shift();
    }
    if (requestTimes.length >= RATE_LIMIT_REQUESTS) {
      const oldest = requestTimes[0];
      const waitMs = oldest + RATE_LIMIT_PERIOD_MS - now + 10;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    requestTimes.push(Date.now());
  }

  async function notionGet(path: string, token: string, attempt = 1): Promise<unknown> {
    await waitForRateLimit();

    let response: Response;
    try {
      response = await fetch(`${NOTION_API}${path}`, {
        headers: notionHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
      const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return notionGet(path, token, attempt + 1);
      }

      throw new Error(`Notion API GET ${path} network error after ${MAX_RETRIES} attempts: ${detail}`);
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Notion API GET ${path} rate limited after ${MAX_RETRIES} attempts`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 2000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return notionGet(path, token, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Notion API GET ${path} failed (${response.status}): ${body}`);
    }

    return response.json();
  }

  async function notionPost(path: string, token: string, body: unknown, attempt = 1): Promise<unknown> {
    await waitForRateLimit();

    let response: Response;
    try {
      response = await fetch(`${NOTION_API}${path}`, {
        method: "POST",
        headers: notionHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
      const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return notionPost(path, token, body, attempt + 1);
      }

      throw new Error(`Notion API POST ${path} network error after ${MAX_RETRIES} attempts: ${detail}`);
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Notion API POST ${path} rate limited after ${MAX_RETRIES} attempts`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 2000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return notionPost(path, token, body, attempt + 1);
    }

    if (!response.ok) {
      const body2 = await response.text();
      throw new Error(`Notion API POST ${path} failed (${response.status}): ${body2}`);
    }

    return response.json();
  }

  return { notionGet, notionPost };
}

type NotionGetFn = ReturnType<typeof makeNotionRequests>["notionGet"];
type NotionPostFn = ReturnType<typeof makeNotionRequests>["notionPost"];

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Rich text & block conversion ────────────────────────────────────────────

/** Extract plain text from Notion rich_text array. */
function extractRichText(
  richText: Array<{ plain_text: string; annotations?: Record<string, boolean>; href?: string }>,
): string {
  if (!richText || !Array.isArray(richText)) return "";
  return richText
    .map((item) => {
      let text = item.plain_text ?? "";
      const ann = item.annotations;
      if (ann?.bold) text = `**${text}**`;
      if (ann?.italic) text = `*${text}*`;
      if (ann?.strikethrough) text = `~~${text}~~`;
      if (ann?.code) text = `\`${text}\``;
      if (item.href) text = `[${text}](${item.href})`;
      return text;
    })
    .join("");
}

/** Convert a single Notion block to markdown text. */
function blockToMarkdown(block: { type: string; [key: string]: unknown }, depth: number): string {
  const type = block.type;
  const data = block[type] as Record<string, unknown> | undefined;
  if (!data) return "";

  const richText = data.rich_text as
    | Array<{ plain_text: string; annotations?: Record<string, boolean>; href?: string }>
    | undefined;
  const text = richText ? extractRichText(richText) : "";
  const indent = "  ".repeat(depth);

  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `${indent}- ${text}`;
    case "numbered_list_item":
      return `${indent}1. ${text}`;
    case "to_do": {
      const checked = (data.checked as boolean) ? "x" : " ";
      return `${indent}- [${checked}] ${text}`;
    }
    case "quote":
      return `> ${text}`;
    case "callout": {
      const icon = data.icon as { emoji?: string } | undefined;
      const emoji = icon?.emoji ?? "";
      return `**${emoji} ${text}**`;
    }
    case "code": {
      const lang = (data.language as string) ?? "";
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "divider":
      return "---";
    case "equation": {
      const expr = (data.expression as string) ?? "";
      return `$$\n${expr}\n$$`;
    }
    case "bookmark":
    case "embed": {
      const url = (data.url as string) ?? "";
      return url ? `[${type}](${url})` : "";
    }
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const caption = data.caption ? extractRichText(data.caption as Array<{ plain_text: string }>) : "";
      return caption ? `[${type}: ${caption}]` : `[${type}]`;
    }
    case "child_page": {
      const title = (data.title as string) ?? "";
      return `[Child Page: ${title}]`;
    }
    case "child_database": {
      const dbTitle = (data.title as string) ?? "";
      return `[Database: ${dbTitle}]`;
    }
    default:
      return text;
  }
}

/** Recursively fetch blocks and convert to markdown. */
async function extractPageContent(
  pageId: string,
  token: string,
  logger: Logger,
  notionGet: NotionGetFn,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_BLOCK_DEPTH) return [];

  const lines: string[] = [];
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const path = startCursor
      ? `/blocks/${pageId}/children?start_cursor=${startCursor}&page_size=${PAGE_SIZE}`
      : `/blocks/${pageId}/children?page_size=${PAGE_SIZE}`;

    let response: { results: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null };
    try {
      response = (await notionGet(path, token)) as typeof response;
    } catch (err) {
      logger.debug({ err, pageId, depth }, "Failed to fetch blocks (may be inaccessible)");
      break;
    }

    for (const block of response.results) {
      const md = blockToMarkdown(block as { type: string; [key: string]: unknown }, depth);
      if (md) lines.push(md);

      if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
        const childLines = await extractPageContent(block.id as string, token, logger, notionGet, depth + 1);
        lines.push(...childLines);
      }
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return lines;
}

/**
 * Check if a page has block content (non-empty).
 * Fetches just the first block to check cheaply.
 */
async function pageHasBlocks(pageId: string, token: string, notionGet: NotionGetFn): Promise<boolean> {
  try {
    const response = (await notionGet(`/blocks/${pageId}/children?page_size=1`, token)) as {
      results: Array<Record<string, unknown>>;
    };
    return response.results.length > 0;
  } catch {
    return false;
  }
}

// ── Property helpers ────────────────────────────────────────────────────────

/** Format database page properties into readable text. */
function formatPropertyValue(prop: { type: string; [key: string]: unknown }): string {
  const type = prop.type;
  const value = prop[type];

  if (value === null || value === undefined) return "";

  switch (type) {
    case "title":
    case "rich_text":
      return extractRichText(value as Array<{ plain_text: string }>);
    case "number":
      return String(value);
    case "url":
    case "email":
    case "phone_number":
      return String(value ?? "");
    case "checkbox":
      return value ? "Yes" : "No";
    case "select":
    case "status":
      return (value as { name: string })?.name ?? "";
    case "multi_select":
      return Array.isArray(value) ? value.map((o: { name: string }) => o.name).join(", ") : "";
    case "date": {
      const d = value as { start?: string; end?: string };
      return d.end ? `${d.start} – ${d.end}` : (d.start ?? "");
    }
    case "people":
      return Array.isArray(value) ? value.map((p: { name: string }) => p.name).join(", ") : "";
    case "relation":
      return Array.isArray(value) ? `${value.length} relation(s)` : "";
    case "files":
      return Array.isArray(value) ? `${value.length} file(s)` : "";
    case "formula": {
      const f = value as { type: string; [key: string]: unknown };
      return String(f[f.type] ?? "");
    }
    default:
      return "";
  }
}

/** Extract title from a Notion page's properties. */
function extractPageTitle(properties: Record<string, { type: string; [key: string]: unknown }>): string {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") {
      return extractRichText(prop.title as Array<{ plain_text: string }>);
    }
  }
  return "Untitled";
}

/**
 * Extract people from properties (Assignee, Owner, etc.) for entity linking.
 * Returns array of { name, id } for person seeding + assignee linking.
 */
function extractPeopleFromProperties(
  properties: Record<string, { type: string; [key: string]: unknown }>,
): Array<{ name: string; id: string }> {
  const people: Array<{ name: string; id: string }> = [];
  for (const prop of Object.values(properties)) {
    if (prop.type === "people" && Array.isArray(prop.people)) {
      for (const person of prop.people) {
        const p = person as { id?: string; name?: string; object?: string };
        if (p.name && p.id) {
          people.push({ name: p.name, id: p.id });
        }
      }
    }
  }
  return people;
}

// ── Hierarchy helpers ───────────────────────────────────────────────────────

interface PageInfo {
  id: string;
  title: string;
  parentId: string | null;
  parentType: "workspace" | "page_id" | "database_id" | "block_id";
  url: string;
  lastEditedTime: string;
  createdTime: string;
}

/**
 * Build ancestor chain as parentEntities for a given page, walking up the
 * hierarchy map. Stops at workspace root.
 */
function buildParentEntities(
  pageId: string,
  hierarchyMap: Map<string, PageInfo>,
): Array<{ source: string; sourceId: string; contextSnippet?: string }> {
  const parents: Array<{ source: string; sourceId: string; contextSnippet?: string }> = [];
  let currentId: string | null = pageId;
  const seen = new Set<string>();

  while (currentId) {
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const info = hierarchyMap.get(currentId);
    if (!info) break;

    if (info.parentType === "workspace") break;

    const parentId = info.parentId;
    if (!parentId) break;

    const parentInfo = hierarchyMap.get(parentId);
    if (parentInfo) {
      parents.push({
        source: "notion",
        sourceId: parentId,
        contextSnippet: `In: ${parentInfo.title}`,
      });
    }

    currentId = parentId;
  }

  return parents;
}

/**
 * Build a source_path string from the hierarchy (e.g., "Teamspace Home / Onboarding").
 */
function buildSourcePath(pageId: string, hierarchyMap: Map<string, PageInfo>): string | null {
  const parts: string[] = [];
  let currentId: string | null = pageId;
  const seen = new Set<string>();

  while (currentId) {
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const info = hierarchyMap.get(currentId);
    if (!info) break;
    if (info.parentType === "workspace") {
      parts.unshift(info.title);
      break;
    }

    const parentId = info.parentId;
    if (!parentId) break;

    const parentInfo = hierarchyMap.get(parentId);
    if (parentInfo) {
      parts.unshift(parentInfo.title);
    }
    currentId = parentId;
  }

  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * Filter the hierarchy map to only include pages that are descendants
 * of the selected root pages. Used for scope filtering.
 */
function filterHierarchyByRootPages(
  hierarchyMap: Map<string, PageInfo>,
  allowedRootPages: string[],
): Map<string, PageInfo> {
  const allowedSet = new Set(allowedRootPages);

  function isInScope(pageId: string, seen = new Set<string>()): boolean {
    if (allowedSet.has(pageId)) return true;
    if (seen.has(pageId)) return false;
    seen.add(pageId);

    const info = hierarchyMap.get(pageId);
    if (!info) return false;
    if (info.parentType === "workspace") return false;
    if (!info.parentId) return false;

    return isInScope(info.parentId, seen);
  }

  const filtered = new Map<string, PageInfo>();
  for (const [id, info] of hierarchyMap) {
    if (isInScope(id)) {
      filtered.set(id, info);
    }
  }
  return filtered;
}

// ── Database description ────────────────────────────────────────────────────

interface NotionDbSchema {
  properties: Record<string, { type: string; name: string }>;
}

/**
 * Generate a rich description for a database: column schema + sample rows
 * formatted as a markdown table. Like treating a spreadsheet/CSV.
 */
async function generateDatabaseDescription(
  dbId: string,
  dbTitle: string,
  schema: NotionDbSchema,
  token: string,
  notionPost: NotionPostFn,
): Promise<string> {
  // Get column names and types (skip title — it's always present)
  const columns = Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: prop.type,
  }));

  const columnList = columns.map((c) => `${c.name} (${c.type})`).join(", ");

  // Fetch first N rows for sample data
  let sampleRows: Array<Record<string, { type: string; [key: string]: unknown }>> = [];
  let totalCount = 0;
  try {
    const response = (await notionPost(`/databases/${dbId}/query`, token, { page_size: DB_DESCRIPTION_ROWS })) as {
      results: Array<Record<string, unknown>>;
    };
    sampleRows = response.results.map((r) => r.properties as Record<string, { type: string; [key: string]: unknown }>);

    // Get approximate count via a separate query with page_size=1
    const countResponse = (await notionPost(`/databases/${dbId}/query`, token, { page_size: 1 })) as {
      results: unknown[];
      has_more: boolean;
    };
    // We can't get exact count cheaply — just indicate if there are more
    totalCount = sampleRows.length + (countResponse.has_more ? 100 : 0); // rough estimate
  } catch {
    // If query fails, just return schema description
    return `# ${dbTitle}\n\nDatabase. Columns: ${columnList}`;
  }

  // Pick display columns: title + up to 4 most informative columns
  const titleCol = columns.find((c) => c.type === "title");
  const displayCols = [titleCol, ...columns.filter((c) => c.type !== "title").slice(0, 4)].filter(Boolean) as Array<{
    name: string;
    type: string;
  }>;

  // Build markdown table
  const header = `| ${displayCols.map((c) => c.name).join(" | ")} |`;
  const separator = `|${displayCols.map(() => "---").join("|")}|`;
  const rows = sampleRows.map((props) => {
    const cells = displayCols.map((col) => {
      const prop = props[col.name];
      if (!prop) return "—";
      const val = formatPropertyValue(prop);
      // Truncate long values for the table
      return val ? (val.length > 60 ? `${val.slice(0, 57)}...` : val) : "—";
    });
    return `| ${cells.join(" | ")} |`;
  });

  const countStr = totalCount > sampleRows.length ? `${totalCount}+` : String(sampleRows.length);
  const lines = [
    `# ${dbTitle}`,
    "",
    `Database with ${countStr} entries. Columns: ${columnList}`,
    "",
    header,
    separator,
    ...rows,
  ];

  return lines.join("\n");
}

// ── OAuth token refresh ─────────────────────────────────────────────────────

async function refreshNotionToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const basicAuth = Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString("base64");
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
  };

  return {
    ...credentials,
    access_token: data.access_token,
    token_type: data.token_type,
    ...(data.expires_in && { expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString() }),
  };
}

// ── Main connector ──────────────────────────────────────────────────────────

export function createNotionConnector(): Connector {
  const { notionGet, notionPost } = makeNotionRequests();

  return {
    type: "notion",

    async validateCredentials(credentials) {
      const token = getAccessToken(credentials);
      await notionGet("/users/me", token);
    },

    async *sync({ credentials, scopeConfig, cursor, logger, onEntitySeed, onPersonSeed }) {
      const token = getAccessToken(credentials);
      const since = cursor ?? null;
      const allowedRootPages = (scopeConfig.rootPages as string[] | undefined) ?? [];

      // ── Phase 1: Seed workspace members ──
      logger.info("Phase 1: Discovering workspace members");
      await seedWorkspaceMembers(token, logger, notionGet, onPersonSeed);

      // ── Phase 2: Build page hierarchy map ──
      // Don't seed entities yet — seed after scope filtering to avoid out-of-scope entities
      logger.info("Phase 2: Building page hierarchy map");
      let hierarchyMap = await buildHierarchyMap(token, logger, notionGet, notionPost);
      logger.info({ pageCount: hierarchyMap.size }, "Hierarchy map built");

      // Apply scope filter: only keep pages that descend from selected root pages
      if (allowedRootPages.length > 0) {
        hierarchyMap = filterHierarchyByRootPages(hierarchyMap, allowedRootPages);
        logger.info({ filtered: hierarchyMap.size, rootPages: allowedRootPages.length }, "Hierarchy filtered by scope");
      }

      // Seed page entities for structural pages (pages that are parents of other in-scope pages)
      if (onEntitySeed) {
        const parentIds = new Set<string>();
        for (const info of hierarchyMap.values()) {
          if (info.parentId && info.parentType === "page_id") {
            parentIds.add(info.parentId);
          }
        }
        for (const parentId of parentIds) {
          const info = hierarchyMap.get(parentId);
          if (info) {
            await onEntitySeed({
              name: info.title,
              sourceType: "notion_page",
              source: "notion",
              sourceId: parentId,
              sourceUrl: info.url,
            });
          }
        }
        logger.info({ structuralPages: parentIds.size }, "Structural page entities seeded (post-filter)");
      }

      // ── Phase 3: Sync databases ──
      logger.info("Phase 3: Syncing databases");
      const indexedDbPageIds = new Set<string>();
      yield* syncDatabases(
        token,
        since,
        logger,
        notionGet,
        notionPost,
        hierarchyMap,
        onEntitySeed,
        onPersonSeed,
        indexedDbPageIds,
        allowedRootPages,
      );

      // ── Phase 4: Sync standalone pages ──
      logger.info("Phase 4: Syncing standalone pages");
      yield* syncStandalonePages(token, since, logger, notionGet, hierarchyMap, indexedDbPageIds);
    },

    async getCursor() {
      return new Date().toISOString();
    },

    async refreshTokens(credentials) {
      if (credentials.expires_at && new Date(credentials.expires_at) > new Date()) {
        return null;
      }
      return refreshNotionToken(credentials);
    },

    async browse({ credentials }) {
      const token = getAccessToken(credentials);
      const jobId = startNotionBrowse(token);
      return { type: "async" as const, jobId };
    },

    async browseExisting({ credentials }) {
      const token = getAccessToken(credentials);
      const pages = await browseNotionRootPages(token);
      return {
        type: "flat" as const,
        items: pages.map((p) => ({ id: p.id, name: p.title, url: p.url })),
      };
    },
  };
}

// ── Phase 1: Workspace members ──────────────────────────────────────────────

async function seedWorkspaceMembers(
  token: string,
  logger: Logger,
  notionGet: NotionGetFn,
  onPersonSeed?: PersonEntitySeedCallback,
): Promise<void> {
  if (!onPersonSeed) return;

  let startCursor: string | undefined;
  let hasMore = true;
  let count = 0;

  while (hasMore) {
    const path = startCursor
      ? `/users?start_cursor=${startCursor}&page_size=${PAGE_SIZE}`
      : `/users?page_size=${PAGE_SIZE}`;

    try {
      const response = (await notionGet(path, token)) as {
        results: Array<{ id: string; name: string; type: string; person?: { email?: string } }>;
        has_more: boolean;
        next_cursor: string | null;
      };

      for (const user of response.results) {
        if (user.type !== "person" || !user.name) continue;
        await onPersonSeed({
          name: user.name,
          email: user.person?.email,
          subtype: "internal",
          source: "notion",
          sourceId: `user:${user.id}`,
        });
        count++;
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor ?? undefined;
    } catch (err) {
      logger.warn({ err }, "Failed to fetch workspace members");
      break;
    }
  }

  logger.info({ count }, "Workspace members seeded");
}

// ── Phase 2: Hierarchy map ──────────────────────────────────────────────────

async function buildHierarchyMap(
  token: string,
  logger: Logger,
  notionGet: NotionGetFn,
  notionPost: NotionPostFn,
): Promise<Map<string, PageInfo>> {
  const map = new Map<string, PageInfo>();

  // Paginate through ALL pages via /search
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "page" },
      page_size: PAGE_SIZE,
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = (await notionPost("/search", token, body)) as {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const page of response.results) {
      if (page.archived || page.in_trash) continue;

      const parent = page.parent as { type: string; page_id?: string; database_id?: string; block_id?: string };
      const properties = page.properties as Record<string, { type: string; [key: string]: unknown }>;
      const title = extractPageTitle(properties);
      const pageId = page.id as string;

      let parentId: string | null = null;
      const parentType = parent.type as PageInfo["parentType"];

      if (parentType === "page_id") parentId = parent.page_id ?? null;
      else if (parentType === "database_id") parentId = parent.database_id ?? null;
      else if (parentType === "block_id") parentId = parent.block_id ?? null;

      map.set(pageId, {
        id: pageId,
        title,
        parentId,
        parentType,
        url: page.url as string,
        lastEditedTime: page.last_edited_time as string,
        createdTime: page.created_time as string,
      });
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  // Resolve block_id parents → find the actual parent page.
  // Pages with parent.type === "block_id" are inside toggles/columns.
  // We need to resolve the block to find its parent page for the hierarchy.
  const blockParents = [...map.values()].filter((p) => p.parentType === "block_id" && p.parentId);
  for (const page of blockParents) {
    try {
      const block = (await notionGet(`/blocks/${page.parentId}`, token)) as {
        parent: { type: string; page_id?: string; block_id?: string };
      };
      // Walk up until we find a page_id parent
      if (block.parent.type === "page_id" && block.parent.page_id) {
        page.parentId = block.parent.page_id;
        page.parentType = "page_id";
      }
    } catch {
      // Can't resolve — leave as-is
    }
  }

  return map;
}

// ── Phase 3: Database sync ──────────────────────────────────────────────────

async function* syncDatabases(
  token: string,
  since: string | null,
  logger: Logger,
  notionGet: NotionGetFn,
  notionPost: NotionPostFn,
  hierarchyMap: Map<string, PageInfo>,
  onEntitySeed?: EntitySeedCallback,
  onPersonSeed?: PersonEntitySeedCallback,
  indexedDbPageIds?: Set<string>,
  allowedRootPages?: string[],
): AsyncGenerator<SyncedItem> {
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "database" },
      page_size: PAGE_SIZE,
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = (await notionPost("/search", token, body)) as {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const db of response.results) {
      if (db.archived || db.in_trash) continue;

      const lastEdited = db.last_edited_time as string;
      if (since && lastEdited && lastEdited < since) continue;

      // Scope filter: if root pages are selected, skip databases outside scope
      if (allowedRootPages && allowedRootPages.length > 0) {
        const dbParentCheck = db.parent as { type: string; page_id?: string; block_id?: string } | undefined;
        const parentType = dbParentCheck?.type;

        if (parentType === "workspace") {
          // Workspace-root databases don't belong to any root page — skip
          continue;
        }

        // For page_id parents, check directly against the filtered hierarchy
        if (parentType === "page_id") {
          if (!dbParentCheck?.page_id || !hierarchyMap.has(dbParentCheck.page_id)) continue;
        } else if (parentType === "block_id" && dbParentCheck?.block_id) {
          // Database inside a toggle/column — resolve block to find parent page
          try {
            const block = (await notionGet(`/blocks/${dbParentCheck.block_id}`, token)) as {
              parent: { type: string; page_id?: string; block_id?: string };
            };
            const resolvedPageId = block.parent.type === "page_id" ? block.parent.page_id : null;
            if (!resolvedPageId || !hierarchyMap.has(resolvedPageId)) continue;
          } catch {
            // Can't resolve block parent — skip to be safe
            continue;
          }
        } else {
          // Unknown parent type — skip to be safe
          continue;
        }
      }

      const titleArr = (db.title as Array<{ plain_text: string }>) ?? [];
      const title = extractRichText(titleArr);
      const dbId = db.id as string;
      const url = db.url as string;
      const dbProperties = db.properties as Record<string, { type: string; name: string }>;

      // Seed database as entity — skip generic names (they're still indexed as files)
      const isGenericName = GENERIC_DB_NAMES.has((title || "").trim().toLowerCase());
      if (onEntitySeed && !isGenericName && title) {
        await onEntitySeed({
          name: title,
          sourceType: "notion_database",
          source: "notion",
          sourceId: dbId,
          sourceUrl: url,
        });
      }

      // Build parent entities for the database itself
      const dbParent = db.parent as { type: string; page_id?: string; block_id?: string } | undefined;
      const dbParentEntities: SyncedItem["parentEntities"] = [];
      if (dbParent?.type === "page_id" && dbParent.page_id) {
        const parentInfo = hierarchyMap.get(dbParent.page_id);
        if (parentInfo) {
          dbParentEntities.push({
            source: "notion",
            sourceId: dbParent.page_id,
            contextSnippet: `In: ${parentInfo.title}`,
          });
        }
        // Also walk up the hierarchy
        dbParentEntities.push(...buildParentEntities(dbParent.page_id, hierarchyMap));
      }

      // Classify: table vs content-collection by sampling rows for blocks
      const isContentCollection = await classifyDatabase(dbId, token, notionGet, notionPost, logger);
      logger.info({ dbId, title, isContentCollection }, "Database classified");

      // Generate rich description (headers + sample rows)
      let description: string;
      try {
        description = await generateDatabaseDescription(
          dbId,
          title || "Untitled Database",
          { properties: dbProperties },
          token,
          notionPost,
        );
      } catch (err) {
        logger.warn({ err, dbId }, "Failed to generate database description");
        description = `# ${title}\n\nDatabase`;
      }

      // Yield the database itself as a structured indexed file
      yield {
        providerFileId: `db-${dbId}`,
        providerUrl: url ?? null,
        fileName: title || "Untitled Database",
        fileType: "database",
        contentCategory: "structured",
        content: description,
        sourcePath: buildSourcePath(dbId, hierarchyMap),
        contentHash: contentHash(description),
        sourceCreatedAt: (db.created_time as string) ?? null,
        sourceUpdatedAt: lastEdited ?? null,
        parentEntities: dbParentEntities.length > 0 ? dbParentEntities : undefined,
      };

      // If content-collection, index individual rows that have block content
      if (isContentCollection) {
        yield* syncContentCollectionRows(
          dbId,
          title,
          url,
          token,
          since,
          logger,
          notionGet,
          notionPost,
          hierarchyMap,
          onPersonSeed,
          indexedDbPageIds,
        );
      }
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }
}

/**
 * Classify a database as table (Shape 1) or content-collection (Shape 2).
 * Samples first N rows and checks if any have block content.
 */
async function classifyDatabase(
  dbId: string,
  token: string,
  notionGet: NotionGetFn,
  notionPost: NotionPostFn,
  logger: Logger,
): Promise<boolean> {
  try {
    const response = (await notionPost(`/databases/${dbId}/query`, token, { page_size: DB_SAMPLE_SIZE })) as {
      results: Array<{ id: string }>;
    };

    for (const row of response.results) {
      if (await pageHasBlocks(row.id, token, notionGet)) {
        return true;
      }
    }
  } catch (err) {
    logger.debug({ err, dbId }, "Failed to classify database, defaulting to table");
  }

  return false;
}

/**
 * Sync rows from a content-collection database.
 * Each row with block content is indexed as a document.
 */
async function* syncContentCollectionRows(
  dbId: string,
  dbTitle: string,
  dbUrl: string,
  token: string,
  since: string | null,
  logger: Logger,
  notionGet: NotionGetFn,
  notionPost: NotionPostFn,
  hierarchyMap: Map<string, PageInfo>,
  onPersonSeed?: PersonEntitySeedCallback,
  indexedDbPageIds?: Set<string>,
): AsyncGenerator<SyncedItem> {
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = { page_size: PAGE_SIZE };
    if (startCursor) body.start_cursor = startCursor;

    let response: {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };
    try {
      response = (await notionPost(`/databases/${dbId}/query`, token, body)) as typeof response;
    } catch (err) {
      logger.warn({ err, dbId }, "Failed to query database rows");
      break;
    }

    for (const page of response.results) {
      if (page.archived || page.in_trash) continue;

      const lastEdited = page.last_edited_time as string;
      if (since && lastEdited && lastEdited < since) continue;

      const pageId = page.id as string;
      const url = page.url as string;
      const properties = page.properties as Record<string, { type: string; [key: string]: unknown }>;
      const title = extractPageTitle(properties);

      // Fetch block content — skip rows without body
      let lines: string[];
      try {
        lines = await extractPageContent(pageId, token, logger, notionGet);
      } catch (err) {
        logger.debug({ err, pageId }, "Failed to extract row content");
        continue;
      }

      if (lines.length === 0) continue;

      indexedDbPageIds?.add(pageId);

      // Properties as metadata header (like ClickUp task metadata)
      const propsText = Object.entries(properties)
        .filter(([, prop]) => prop.type !== "title")
        .map(([key, prop]) => {
          const val = formatPropertyValue(prop);
          return val ? `${key}: ${val}` : null;
        })
        .filter(Boolean)
        .join(" | ");

      const content = propsText
        ? `${title}\n\n${propsText}\n\n${lines.join("\n\n")}`
        : `${title}\n\n${lines.join("\n\n")}`;

      // Extract people for entity linking
      const people = extractPeopleFromProperties(properties);
      if (onPersonSeed) {
        for (const person of people) {
          await onPersonSeed({
            name: person.name,
            subtype: "internal",
            source: "notion",
            sourceId: `user:${person.id}`,
          });
        }
      }

      // Parent entities: link to the database
      const parentEntities: SyncedItem["parentEntities"] = [
        { source: "notion", sourceId: dbId, contextSnippet: `In database: ${dbTitle}` },
      ];

      yield {
        providerFileId: pageId,
        providerUrl: url ?? null,
        fileName: title || "Untitled",
        fileType: "page",
        contentCategory: "document",
        content,
        sourcePath: dbTitle,
        contentHash: contentHash(content),
        sourceCreatedAt: (page.created_time as string) ?? null,
        sourceUpdatedAt: lastEdited ?? null,
        assignees: people.length > 0 ? people.map((p) => ({ name: p.name })) : undefined,
        parentEntities,
      };
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }
}

// ── Phase 4: Standalone pages ───────────────────────────────────────────────

/**
 * Sync standalone pages (not database rows) that have block content.
 * Uses the hierarchy map built in Phase 2 to avoid re-fetching from /search.
 */
async function* syncStandalonePages(
  token: string,
  since: string | null,
  logger: Logger,
  notionGet: NotionGetFn,
  hierarchyMap: Map<string, PageInfo>,
  indexedDbPageIds: Set<string>,
): AsyncGenerator<SyncedItem> {
  let yielded = 0;

  for (const page of hierarchyMap.values()) {
    // Skip database children — handled in Phase 3
    if (page.parentType === "database_id") continue;

    // Skip pages already indexed as content-collection rows
    if (indexedDbPageIds.has(page.id)) continue;

    // Incremental: skip pages not edited since last sync
    if (since && page.lastEditedTime && page.lastEditedTime < since) continue;

    // Fetch block content
    let lines: string[];
    try {
      lines = await extractPageContent(page.id, token, logger, notionGet);
    } catch (err) {
      logger.debug({ err, pageId: page.id }, "Failed to extract standalone page content");
      continue;
    }

    // Skip pages with no content (structural containers only)
    if (lines.length === 0) continue;

    const content = `${page.title}\n\n${lines.join("\n\n")}`;
    const parentEntities = buildParentEntities(page.id, hierarchyMap);
    const sourcePath = buildSourcePath(page.id, hierarchyMap);

    yield {
      providerFileId: page.id,
      providerUrl: page.url ?? null,
      fileName: page.title || "Untitled",
      fileType: "page",
      contentCategory: "document",
      content,
      sourcePath,
      contentHash: contentHash(content),
      sourceCreatedAt: page.createdTime ?? null,
      sourceUpdatedAt: page.lastEditedTime ?? null,
      parentEntities: parentEntities.length > 0 ? parentEntities : undefined,
    };

    yielded++;
  }

  logger.info({ yielded }, "Standalone pages synced");
}

// ── Browse API (for scope selection) ────────────────────────────────────────

export interface NotionRootPage {
  id: string;
  title: string;
  url: string;
}

export interface BrowseStatus {
  scanning: boolean;
  pagesScanned: number;
  rootPages: NotionRootPage[];
  error?: string;
}

const MAX_BROWSE_CALLS = 15;

/** In-memory browse jobs. Auto-expire after 5 minutes. */
const browseJobs = new Map<string, BrowseStatus>();

function cleanExpiredJobs() {
  // Simple cleanup — keep max 10 jobs
  if (browseJobs.size > 10) {
    const keys = [...browseJobs.keys()];
    for (let i = 0; i < keys.length - 10; i++) {
      browseJobs.delete(keys[i]);
    }
  }
}

/**
 * Start a background scan for root pages. Returns a browseId immediately.
 * The scan runs in the background; poll getBrowseStatus() for results.
 */
export function startNotionBrowse(token: string): string {
  cleanExpiredJobs();

  const browseId = `nb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const status: BrowseStatus = { scanning: true, pagesScanned: 0, rootPages: [] };
  browseJobs.set(browseId, status);

  // Run scan in background
  scanRootPages(token, status).catch((err) => {
    status.scanning = false;
    status.error = err instanceof Error ? err.message : String(err);
  });

  return browseId;
}

export function getBrowseStatus(browseId: string): BrowseStatus | null {
  return browseJobs.get(browseId) ?? null;
}

async function scanRootPages(token: string, status: BrowseStatus): Promise<void> {
  const { notionPost } = makeNotionRequests();
  const seen = new Set<string>();
  let startCursor: string | undefined;
  let hasMore = true;
  let apiCalls = 0;

  while (hasMore && apiCalls < MAX_BROWSE_CALLS) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "page" },
      page_size: PAGE_SIZE,
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = (await notionPost("/search", token, body)) as {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };
    apiCalls++;
    status.pagesScanned += response.results.length;

    for (const page of response.results) {
      if (page.archived || page.in_trash) continue;
      const parent = page.parent as { type: string } | undefined;
      if (parent?.type !== "workspace") continue;

      const pageId = page.id as string;
      if (seen.has(pageId)) continue;
      seen.add(pageId);

      const properties = page.properties as Record<string, { type: string; [key: string]: unknown }>;
      const title = extractPageTitle(properties);

      status.rootPages.push({
        id: pageId,
        title: title || "(untitled)",
        url: (page.url as string) ?? "",
      });
      // Keep sorted as we go
      status.rootPages.sort((a, b) => a.title.localeCompare(b.title));
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  status.scanning = false;
}

/**
 * Synchronous browse for existing connectors (used in manage dialog).
 * Uses the capped scan and returns when done.
 */
export async function browseNotionRootPages(token: string): Promise<NotionRootPage[]> {
  const status: BrowseStatus = { scanning: true, pagesScanned: 0, rootPages: [] };
  await scanRootPages(token, status);
  return status.rootPages;
}
