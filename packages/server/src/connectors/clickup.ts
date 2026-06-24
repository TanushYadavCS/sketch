/**
 * ClickUp connector.
 *
 * Uses the ClickUp v2 REST API for tasks and v3 API for Docs.
 * Auth: API key (personal or workspace token) or OAuth.
 *
 * Sync strategy:
 * - Full hierarchical traversal: Workspace → Space → Folder → List → Task
 * - Docs fetched at workspace level via v3 API
 * - Includes closed/completed tasks for full historical context
 * - Incremental sync via `date_updated_gt` timestamp filter on tasks;
 *   Docs filtered client-side by `date_updated` against cursor
 * - Content hashing for change detection on unchanged items
 */
import { createHash } from "node:crypto";
import pino, { type Logger } from "pino";
import type {
  Connector,
  ConnectorCredentials,
  EntitySeed,
  EntitySeedCallback,
  OAuthCredentials,
  PersonEntitySeedCallback,
  SyncedItem,
} from "./types";

const CLICKUP_API = "https://api.clickup.com/api/v2";
const CLICKUP_API_V3 = "https://api.clickup.com/api/v3";
const TOKEN_ENDPOINT = "https://app.clickup.com/api/v2/oauth/token";

interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string; type: string };
  priority?: { priority: string } | null;
  creator?: { id?: number | string; username?: string; email?: string };
  assignees: Array<{ id?: number; username: string; email?: string; profilePicture?: string }>;
  tags: Array<{ name: string }>;
  date_created?: string;
  date_updated?: string;
  due_date?: string | null;
  url: string;
  parent?: string | null;
  list: { id: string; name: string };
  folder?: { id: string; name: string };
  space: { id: string };
  custom_fields?: Array<{ name: string; value: unknown; type: string }>;
}

interface ClickUpMember {
  user: { id: number; username: string; email?: string };
}

export interface ClickUpSpace {
  id: string;
  name: string;
  private?: boolean;
  members?: ClickUpMember[];
  features?: { sprints?: { enabled?: boolean } };
}

interface ClickUpFolder {
  id: string;
  name: string;
}

export interface ClickUpList {
  id: string;
  name: string;
  task_count?: number;
  start_date?: string | null;
  due_date?: string | null;
}

interface ClickUpDoc {
  id: string;
  name: string;
  date_created?: string;
  date_updated?: string;
  parent?: { id: string; type: number };
  workspace_id: string;
}

interface ClickUpDocPage {
  id: string;
  name: string;
  content?: string;
  order_index?: number;
  date_created?: string;
  date_updated?: string;
  pages?: ClickUpDocPage[];
}

function getAccessToken(credentials: ConnectorCredentials): string {
  if (credentials.type === "api_key") return credentials.api_key;
  if (credentials.type === "oauth") return credentials.access_token;
  throw new Error("ClickUp connector requires api_key or oauth credentials");
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

async function clickupRequest(path: string, token: string, logger: Logger, attempt = 1): Promise<unknown> {
  const url = `${CLICKUP_API}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout, etc.)
    const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
    const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

    if (attempt < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn({ path, attempt, detail, waitMs }, "Network error, retrying");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return clickupRequest(path, token, logger, attempt + 1);
    }

    throw new Error(`ClickUp API ${path} network error after ${MAX_RETRIES} attempts: ${detail}`);
  }

  if (response.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`ClickUp API ${path} rate limited after ${MAX_RETRIES} attempts`);
    }
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
    logger.debug({ path, waitMs }, "Rate limited, waiting");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return clickupRequest(path, token, logger, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text();

    // Retry on server errors (5xx)
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn({ path, status: response.status, attempt, waitMs }, "Server error, retrying");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return clickupRequest(path, token, logger, attempt + 1);
    }

    throw new Error(`ClickUp API ${path} failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function clickupRequestV3(path: string, token: string, logger: Logger, attempt = 1): Promise<unknown> {
  const url = `${CLICKUP_API_V3}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
    const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

    if (attempt < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn({ path, attempt, detail, waitMs }, "v3 network error, retrying");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return clickupRequestV3(path, token, logger, attempt + 1);
    }

    throw new Error(`ClickUp v3 API ${path} network error after ${MAX_RETRIES} attempts: ${detail}`);
  }

  if (response.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`ClickUp v3 API ${path} rate limited after ${MAX_RETRIES} attempts`);
    }
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
    logger.debug({ path, waitMs }, "v3 rate limited, waiting");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return clickupRequestV3(path, token, logger, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text();

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn({ path, status: response.status, attempt, waitMs }, "v3 server error, retrying");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return clickupRequestV3(path, token, logger, attempt + 1);
    }

    throw new Error(`ClickUp v3 API ${path} failed (${response.status}): ${body}`);
  }

  return response.json();
}

function parseClickUpTimestamp(ms: string | null | undefined): string | null {
  if (!ms) return null;
  const num = Number.parseInt(ms, 10);
  if (Number.isNaN(num)) return null;
  const value = num > 1e12 ? num : num * 1000;
  return new Date(value).toISOString();
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type SyncedTaskCycle = NonNullable<NonNullable<SyncedItem["task"]>["cycle"]>;

/**
 * Detects ClickUp sprints structurally because lists and folders do not expose
 * a dedicated sprint flag. A list is treated as a sprint only when the space has
 * sprints enabled, the list name contains sprint without backlog/archive/template
 * wording, and both list dates are positive epoch strings. Undated sprint lists
 * are intentionally not detected until list-level metadata support is expanded.
 */
export function detectSprintCycle(
  list: ClickUpList,
  space: ClickUpSpace,
  folder?: { id: string; name: string },
): SyncedTaskCycle | null {
  if (space.features?.sprints?.enabled !== true) return null;
  if (!/\bsprint\b/i.test(list.name)) return null;
  if (/\b(backlog|archive|template)\b/i.test(list.name)) return null;
  if (!isPositiveDigitString(list.start_date) || !isPositiveDigitString(list.due_date)) return null;
  const startsAt = parseClickUpTimestamp(list.start_date);
  const endsAt = parseClickUpTimestamp(list.due_date);
  if (!startsAt || !endsAt) return null;
  const sequenceMatch = /\bsprint\s*#?\s*(\d+)/i.exec(list.name);
  return {
    source: "clickup",
    externalRef: list.id,
    name: list.name,
    scopeRef: { source: "clickup", sourceId: folder ? folder.id : space.id },
    startsAt,
    endsAt,
    sequence: sequenceMatch ? Number(sequenceMatch[1]) : undefined,
    isSprint: true,
  };
}

function isPositiveDigitString(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
}

function taskToSyncedItem(
  task: ClickUpTask,
  workspaceName: string,
  workspaceId: string,
  spaceName: string,
  spaceId: string,
  folderName: string | undefined,
  folderId: string | undefined,
  listProjectParent: { id: string; name: string } | undefined,
  accessScope?: SyncedItem["accessScope"],
  cycle?: SyncedTaskCycle,
): SyncedItem {
  const hasDescription = task.description && task.description.trim().length > 0;

  const metadata = [
    `Status: ${task.status.status}`,
    task.priority ? `Priority: ${task.priority.priority}` : null,
    task.assignees.length > 0 ? `Assignees: ${task.assignees.map((a) => a.username).join(", ")}` : null,
    task.tags.length > 0 ? `Tags: ${task.tags.map((t) => t.name).join(", ")}` : null,
    task.due_date ? `Due: ${parseClickUpTimestamp(task.due_date)}` : null,
    `List: ${task.list.name}`,
    folderName ? `Folder: ${folderName}` : null,
    `Space: ${spaceName}`,
    `Workspace: ${workspaceName}`,
  ]
    .filter(Boolean)
    .join(" | ");

  const content = hasDescription ? `${task.name}\n\n${metadata}\n\n${task.description}` : `${task.name}\n\n${metadata}`;

  // Full hierarchical path: Workspace / Space / Folder / List
  const sourcePath = [workspaceName, spaceName, folderName, task.list.name].filter(Boolean).join(" / ");

  const parentEntities: SyncedItem["parentEntities"] = [
    { source: "clickup", sourceId: workspaceId, contextSnippet: `In workspace: ${workspaceName}` },
    { source: "clickup", sourceId: spaceId, contextSnippet: `In space: ${spaceName}` },
  ];
  if (folderId && folderName) {
    parentEntities.push({ source: "clickup", sourceId: folderId, contextSnippet: `In folder: ${folderName}` });
  }
  if (listProjectParent) {
    parentEntities.push({
      source: "clickup",
      sourceId: listProjectParent.id,
      contextSnippet: `In list: ${listProjectParent.name}`,
    });
  }
  const taskProject =
    folderId && folderName
      ? { name: folderName, source: "clickup", sourceId: folderId }
      : listProjectParent
        ? { name: listProjectParent.name, source: "clickup", sourceId: listProjectParent.id }
        : undefined;
  const primaryAssignee = task.assignees.find((assignee) => assignee.username);
  const syncedTask: NonNullable<SyncedItem["task"]> = {
    sourceTaskId: task.id,
    externalRef: task.id,
    title: task.name,
    statusType: task.status.type,
    statusRaw: task.status.status,
    priority: task.priority?.priority,
    dueAt: parseClickUpTimestamp(task.due_date) ?? undefined,
    project: taskProject,
    assignee: primaryAssignee
      ? {
          name: primaryAssignee.username,
          email: primaryAssignee.email,
          source: "clickup",
          sourceId: `assignee:${primaryAssignee.username}`,
        }
      : undefined,
    ...(cycle ? { cycle } : {}),
  };

  return {
    providerFileId: task.id,
    providerUrl: task.url,
    fileName: task.name,
    fileType: task.parent ? "subtask" : "task",
    contentCategory: hasDescription ? "document" : "structured",
    content,
    sourcePath,
    contentHash: contentHash(content),
    sourceCreatedAt: parseClickUpTimestamp(task.date_created ?? null),
    sourceUpdatedAt: parseClickUpTimestamp(task.date_updated ?? null),
    accessScope,
    assignees: task.assignees
      .filter((a) => a.username)
      .map((a) => ({ name: a.username, email: a.email, source: "clickup", sourceId: `assignee:${a.username}` })),
    task: syncedTask,
    authorEmail: task.creator?.email,
    authorName: task.creator?.username,
    authorSourceId: task.creator?.id === undefined ? undefined : `user:${String(task.creator.id)}`,
    parentEntities,
  };
}

function clickupProjectSeed(params: {
  node: ClickUpFolder | ClickUpList;
  workspaceName: string;
  workspaceId: string;
  spaceName: string;
  spaceId: string;
}): EntitySeed {
  return {
    name: params.node.name,
    sourceType: "project",
    source: "clickup",
    sourceId: params.node.id,
    metadata: {
      workspaceName: params.workspaceName,
      workspaceId: params.workspaceId,
      spaceName: params.spaceName,
      spaceId: params.spaceId,
      path: `${params.workspaceName} / ${params.spaceName} / ${params.node.name}`,
    },
  };
}

/** Flatten nested doc pages into a single ordered list. */
function flattenPages(pages: ClickUpDocPage[], depth = 0): Array<ClickUpDocPage & { depth: number }> {
  const result: Array<ClickUpDocPage & { depth: number }> = [];
  const sorted = [...pages].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
  for (const page of sorted) {
    result.push({ ...page, depth });
    if (page.pages?.length) {
      result.push(...flattenPages(page.pages, depth + 1));
    }
  }
  return result;
}

function docToSyncedItem(
  doc: ClickUpDoc,
  pages: ClickUpDocPage[],
  accessScope?: SyncedItem["accessScope"],
): SyncedItem {
  const flat = flattenPages(pages);
  const pageContent = flat
    .map((p) => {
      const level = Math.min(p.depth + 2, 6); // ## for top-level, ### for nested, etc.
      const header = p.name ? `${"#".repeat(level)} ${p.name}` : "";
      return [header, p.content?.trim()].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n---\n\n");

  const content = pageContent ? `# ${doc.name}\n\n${pageContent}` : `# ${doc.name}`;

  return {
    providerFileId: `doc:${doc.id}`,
    providerUrl: `https://app.clickup.com/${doc.workspace_id}/docs/${doc.id}`,
    fileName: doc.name,
    fileType: "doc",
    contentCategory: "document",
    content,
    sourcePath: null,
    contentHash: contentHash(content),
    sourceCreatedAt: parseClickUpTimestamp(doc.date_created ?? null),
    sourceUpdatedAt: parseClickUpTimestamp(doc.date_updated ?? null),
    accessScope,
  };
}

/** Extract emails from ClickUp member lists. */
function extractMemberEmails(members: ClickUpMember[]): string[] {
  return members.filter((m) => m.user.email).map((m) => m.user.email as string);
}

async function refreshClickUpToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ClickUp token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { access_token: string; token_type: string };
  return {
    ...credentials,
    access_token: data.access_token,
    token_type: data.token_type,
  };
}

export function createClickUpConnector(): Connector {
  return {
    type: "clickup",
    perUserAuth: false,
    requiresOAuthClientSetup: false,

    assigneeSourceRefKey(name: string) {
      return `clickup:assignee:${name}`;
    },

    async validateCredentials(credentials) {
      const token = getAccessToken(credentials);
      await clickupRequest("/user", token, pino({ level: "silent" }));
    },

    async *sync({ credentials, scopeConfig, cursor, logger, onEntitySeed, onPersonSeed }) {
      const token = getAccessToken(credentials);
      const allowedWorkspaces = (scopeConfig.workspaces as string[] | undefined) ?? [];
      const allowedSpaces = (scopeConfig.spaces as string[] | undefined) ?? [];
      const seenAssignees = new Map<string, { username: string; email?: string }>();

      // Incremental: convert cursor to Unix ms for date_updated_gt filter
      const sinceMs = cursor ? new Date(cursor).getTime() : undefined;
      if (sinceMs) {
        logger.info({ cursor, sinceMs }, "Incremental sync — filtering tasks updated after cursor");
      }

      const teamsRes = (await clickupRequest("/team", token, logger)) as {
        teams: Array<{ id: string; name: string; members: ClickUpMember[] }>;
      };

      for (const team of teamsRes.teams) {
        // Workspace filter: skip workspaces not in scope
        if (allowedWorkspaces.length > 0 && !allowedWorkspaces.includes(team.id)) {
          continue;
        }
        const workspaceName = team.name.trim();
        const workspaceEmails = extractMemberEmails(team.members);
        logger.info(
          { teamId: team.id, workspaceName, memberCount: workspaceEmails.length },
          "Workspace members resolved",
        );

        // Seed workspace as top-level entity
        if (onEntitySeed) {
          await onEntitySeed({
            name: workspaceName,
            sourceType: "clickup_workspace",
            source: "clickup",
            sourceId: team.id,
            metadata: { memberCount: workspaceEmails.length },
          });
        }

        // Seed workspace members as person entities
        if (onPersonSeed) {
          for (const member of team.members) {
            if (member.user.username) {
              await onPersonSeed({
                name: member.user.username,
                email: member.user.email,
                subtype: "internal",
                source: "clickup",
                sourceId: `user:${member.user.id}`,
              });
            }
          }
        }

        // Workspace-level access scope (used for docs and public spaces)
        const workspaceScope: SyncedItem["accessScope"] = {
          scopeType: "workspace",
          providerScopeId: team.id,
          label: workspaceName,
          memberEmails: workspaceEmails,
        };

        const spacesRes = (await clickupRequest(`/team/${team.id}/space`, token, logger)) as {
          spaces: ClickUpSpace[];
        };

        for (const space of spacesRes.spaces) {
          if (allowedSpaces.length > 0 && !allowedSpaces.includes(space.id)) {
            continue;
          }

          // Seed space as entity with workspace context
          if (onEntitySeed) {
            await onEntitySeed({
              name: space.name,
              sourceType: "clickup_space",
              source: "clickup",
              sourceId: space.id,
              metadata: { private: space.private, workspaceName, workspaceId: team.id },
            });
          }

          // Build access scope for this space.
          // Private spaces use space members; public spaces use all workspace members.
          let spaceScope: SyncedItem["accessScope"];
          if (space.private && space.members) {
            const memberEmails = extractMemberEmails(space.members);
            spaceScope = {
              scopeType: "space",
              providerScopeId: space.id,
              label: space.name,
              memberEmails,
            };
            logger.debug(
              { spaceId: space.id, spaceName: space.name, memberCount: memberEmails.length },
              "Private space — using space members",
            );
          } else {
            spaceScope = workspaceScope;
            logger.debug(
              { spaceId: space.id, spaceName: space.name, memberCount: workspaceEmails.length },
              "Public space — using workspace members",
            );
          }

          const foldersRes = (await clickupRequest(`/space/${space.id}/folder`, token, logger)) as {
            folders: ClickUpFolder[];
          };
          for (const folder of foldersRes.folders) {
            const listsRes = (await clickupRequest(`/folder/${folder.id}/list`, token, logger)) as {
              lists: ClickUpList[];
            };
            if (onEntitySeed && listsRes.lists.length > 0) {
              await onEntitySeed(
                clickupProjectSeed({
                  node: folder,
                  workspaceName,
                  workspaceId: team.id,
                  spaceName: space.name,
                  spaceId: space.id,
                }),
              );
            }
            for (const list of listsRes.lists) {
              const cycle = detectSprintCycle(list, space, { id: folder.id, name: folder.name });
              yield* fetchTasksFromList(
                list.id,
                workspaceName,
                team.id,
                space.name,
                space.id,
                folder.name,
                folder.id,
                undefined,
                token,
                logger,
                spaceScope,
                seenAssignees,
                sinceMs,
                cycle ?? undefined,
              );
            }
          }

          const folderlessListsRes = (await clickupRequest(`/space/${space.id}/list`, token, logger)) as {
            lists: ClickUpList[];
          };
          for (const list of folderlessListsRes.lists) {
            if (onEntitySeed) {
              await onEntitySeed(
                clickupProjectSeed({
                  node: list,
                  workspaceName,
                  workspaceId: team.id,
                  spaceName: space.name,
                  spaceId: space.id,
                }),
              );
            }
            const cycle = detectSprintCycle(list, space, undefined);
            yield* fetchTasksFromList(
              list.id,
              workspaceName,
              team.id,
              space.name,
              space.id,
              undefined,
              undefined,
              { id: list.id, name: list.name },
              token,
              logger,
              spaceScope,
              seenAssignees,
              sinceMs,
              cycle ?? undefined,
            );
          }
        }

        // Sync ClickUp Docs at workspace level
        yield* fetchDocsFromWorkspace(team.id, token, logger, workspaceScope, cursor ?? undefined);
      }

      // Seed assignees collected during task traversal as person entities
      if (onPersonSeed) {
        for (const [, assignee] of seenAssignees) {
          await onPersonSeed({
            name: assignee.username,
            email: assignee.email,
            subtype: "internal",
            source: "clickup",
            sourceId: `assignee:${assignee.username}`,
          });
        }
      }
    },

    async getCursor() {
      // 1-minute overlap buffer to handle items updated during sync
      return new Date(Date.now() - 60_000).toISOString();
    },

    async refreshTokens(credentials) {
      if (credentials.expires_at && new Date(credentials.expires_at) > new Date()) {
        return null;
      }
      return refreshClickUpToken(credentials);
    },

    async browse({ credentials }) {
      const token = getAccessToken(credentials);
      const workspaces = await browseClickUpWorkspaces(token);
      return {
        type: "nested" as const,
        groups: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          items: w.spaces.map((s) => ({ id: s.id, name: s.name })),
        })),
      };
    },
  };
}

async function* fetchTasksFromList(
  listId: string,
  workspaceName: string,
  workspaceId: string,
  spaceName: string,
  spaceId: string,
  folderName: string | undefined,
  folderId: string | undefined,
  listProjectParent: { id: string; name: string } | undefined,
  token: string,
  logger: Logger,
  accessScope?: SyncedItem["accessScope"],
  seenAssignees?: Map<string, { username: string; email?: string }>,
  sinceMs?: number,
  cycle?: SyncedTaskCycle,
): AsyncGenerator<SyncedItem> {
  try {
    let url = `/list/${listId}/task?include_subtasks=true&subtasks=true&include_closed=true`;
    if (sinceMs) {
      url += `&date_updated_gt=${sinceMs}`;
    }

    const tasksRes = (await clickupRequest(url, token, logger)) as { tasks: ClickUpTask[] };

    for (const task of tasksRes.tasks) {
      if (seenAssignees) {
        for (const assignee of task.assignees) {
          if (assignee.username && !seenAssignees.has(assignee.username)) {
            seenAssignees.set(assignee.username, { username: assignee.username, email: assignee.email });
          }
        }
      }
      yield taskToSyncedItem(
        task,
        workspaceName,
        workspaceId,
        spaceName,
        spaceId,
        folderName,
        folderId,
        listProjectParent,
        accessScope,
        cycle,
      );
    }
  } catch (err) {
    logger.warn({ err, listId }, "Failed to fetch tasks from list");
  }
}

async function* fetchDocsFromWorkspace(
  workspaceId: string,
  token: string,
  logger: Logger,
  accessScope?: SyncedItem["accessScope"],
  since?: string,
): AsyncGenerator<SyncedItem> {
  try {
    // Paginate through all docs using cursor.
    // ClickUp's docs API has been observed returning the same next_cursor across iterations
    // (a server-side bug), which would otherwise spin this loop forever. Track seen cursors
    // and bail if one repeats.
    let docCursor: string | undefined;
    const seenCursors = new Set<string>();
    const allDocs: ClickUpDoc[] = [];
    do {
      if (docCursor && seenCursors.has(docCursor)) {
        logger.warn({ workspaceId, docCursor }, "ClickUp doc cursor not advancing, stopping pagination");
        break;
      }
      if (docCursor) seenCursors.add(docCursor);
      const url = docCursor ? `/workspaces/${workspaceId}/docs?cursor=${docCursor}` : `/workspaces/${workspaceId}/docs`;
      const docsRes = (await clickupRequestV3(url, token, logger)) as {
        docs: ClickUpDoc[];
        next_cursor?: string;
      };
      if (docsRes.docs?.length) allDocs.push(...docsRes.docs);
      docCursor = docsRes.next_cursor || undefined;
    } while (docCursor);

    logger.info({ workspaceId, docCount: allDocs.length }, "Fetched workspace docs");

    for (const doc of allDocs) {
      // Incremental: skip docs not updated since last sync
      if (since && doc.date_updated) {
        const updatedAt = parseClickUpTimestamp(doc.date_updated);
        if (updatedAt && updatedAt < since) {
          continue;
        }
      }

      try {
        // v3 pages endpoint returns a flat array, not { pages: [...] }
        const pages = (await clickupRequestV3(
          `/workspaces/${workspaceId}/docs/${doc.id}/pages`,
          token,
          logger,
        )) as ClickUpDocPage[];

        logger.debug({ docId: doc.id, docName: doc.name, pageCount: pages.length }, "Doc pages fetched");

        yield docToSyncedItem(doc, pages, accessScope);
      } catch (err) {
        logger.warn({ err, docId: doc.id, docName: doc.name }, "Failed to fetch doc pages");
        // Yield doc without page content rather than skipping entirely
        yield docToSyncedItem(doc, [], accessScope);
      }
    }
  } catch (err) {
    logger.warn({ err, workspaceId }, "Failed to fetch docs from workspace");
  }
}

// ── Browse API (for scope selection) ────────────────────────────────────────

export interface ClickUpWorkspaceInfo {
  id: string;
  name: string;
  memberCount: number;
  spaces: Array<{ id: string; name: string; private: boolean }>;
}

/**
 * List workspaces and their spaces for the scope picker.
 * Fast — just 1 + N API calls (1 for workspaces, 1 per workspace for spaces).
 */
export async function browseClickUpWorkspaces(token: string): Promise<ClickUpWorkspaceInfo[]> {
  const logger = pino({ level: "silent" });
  const teamsRes = (await clickupRequest("/team", token, logger)) as {
    teams: Array<{ id: string; name: string; members: ClickUpMember[] }>;
  };

  const workspaces: ClickUpWorkspaceInfo[] = [];

  for (const team of teamsRes.teams) {
    const spacesRes = (await clickupRequest(`/team/${team.id}/space`, token, logger)) as {
      spaces: Array<{ id: string; name: string; private?: boolean }>;
    };

    workspaces.push({
      id: team.id,
      name: team.name.trim(),
      memberCount: team.members.length,
      spaces: spacesRes.spaces.map((s) => ({
        id: s.id,
        name: s.name,
        private: s.private ?? false,
      })),
    });
  }

  return workspaces;
}
