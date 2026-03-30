/**
 * ClickUp connector.
 *
 * Uses the ClickUp v2 REST API via direct HTTP calls.
 * Auth: API key (personal or workspace token) or OAuth.
 *
 * Sync strategy:
 * - Full hierarchical traversal: Workspace → Space → Folder → List → Task
 * - No incremental sync API available — every sync is a full crawl
 * - Tasks stored as structured metadata (title, status, assignee, etc.)
 * - Task descriptions stored as document content when present
 *
 * ClickUp has no real change detection API, so we rely on content hashing
 * to detect updates and avoid redundant writes.
 */
import { createHash } from "node:crypto";
import pino, { type Logger } from "pino";
import type {
  Connector,
  ConnectorCredentials,
  EntitySeedCallback,
  OAuthCredentials,
  PersonEntitySeedCallback,
  SyncedItem,
} from "./types";

const CLICKUP_API = "https://api.clickup.com/api/v2";
const TOKEN_ENDPOINT = "https://app.clickup.com/api/v2/oauth/token";

interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string; type: string };
  priority?: { priority: string } | null;
  assignees: Array<{ username: string; profilePicture?: string }>;
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

interface ClickUpSpace {
  id: string;
  name: string;
  private?: boolean;
  members?: ClickUpMember[];
}

interface ClickUpFolder {
  id: string;
  name: string;
}

interface ClickUpList {
  id: string;
  name: string;
  task_count?: number;
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

function taskToSyncedItem(
  task: ClickUpTask,
  spaceName: string,
  folderName: string | undefined,
  accessScope?: SyncedItem["accessScope"],
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
  ]
    .filter(Boolean)
    .join(" | ");

  const content = hasDescription ? `${task.name}\n\n${metadata}\n\n${task.description}` : `${task.name}\n\n${metadata}`;

  const sourcePath = [spaceName, folderName, task.list.name].filter(Boolean).join(" / ");

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
    assignees: task.assignees.filter((a) => a.username).map((a) => ({ name: a.username })),
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

    async validateCredentials(credentials) {
      const token = getAccessToken(credentials);
      await clickupRequest("/user", token, pino({ level: "silent" }));
    },

    async *sync({ credentials, scopeConfig, logger, onEntitySeed, onPersonSeed }) {
      const token = getAccessToken(credentials);
      const allowedSpaces = (scopeConfig.spaces as string[] | undefined) ?? [];
      const seenAssignees = new Map<string, { username: string; email?: string }>();

      const teamsRes = (await clickupRequest("/team", token, logger)) as {
        teams: Array<{ id: string; members: ClickUpMember[] }>;
      };

      for (const team of teamsRes.teams) {
        const workspaceEmails = extractMemberEmails(team.members);
        logger.info({ teamId: team.id, memberCount: workspaceEmails.length }, "Workspace members resolved");

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

        const spacesRes = (await clickupRequest(`/team/${team.id}/space`, token, logger)) as {
          spaces: ClickUpSpace[];
        };

        for (const space of spacesRes.spaces) {
          if (allowedSpaces.length > 0 && !allowedSpaces.includes(space.id)) {
            continue;
          }

          // Seed space as entity
          if (onEntitySeed) {
            await onEntitySeed({
              name: space.name,
              sourceType: "clickup_space",
              source: "clickup",
              sourceId: space.id,
              metadata: { private: space.private },
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
            spaceScope = {
              scopeType: "workspace",
              providerScopeId: team.id,
              label: "Workspace",
              memberEmails: workspaceEmails,
            };
            logger.debug(
              { spaceId: space.id, spaceName: space.name, memberCount: workspaceEmails.length },
              "Public space — using workspace members",
            );
          }

          const foldersRes = (await clickupRequest(`/space/${space.id}/folder`, token, logger)) as {
            folders: ClickUpFolder[];
          };
          for (const folder of foldersRes.folders) {
            // Seed folder as entity
            if (onEntitySeed) {
              await onEntitySeed({
                name: folder.name,
                sourceType: "clickup_folder",
                source: "clickup",
                sourceId: folder.id,
                metadata: { spaceName: space.name, path: `${space.name} / ${folder.name}` },
              });
            }

            const listsRes = (await clickupRequest(`/folder/${folder.id}/list`, token, logger)) as {
              lists: ClickUpList[];
            };
            for (const list of listsRes.lists) {
              yield* fetchTasksFromList(list.id, space.name, folder.name, token, logger, spaceScope, seenAssignees);
            }
          }

          const folderlessListsRes = (await clickupRequest(`/space/${space.id}/list`, token, logger)) as {
            lists: ClickUpList[];
          };
          for (const list of folderlessListsRes.lists) {
            yield* fetchTasksFromList(list.id, space.name, undefined, token, logger, spaceScope, seenAssignees);
          }
        }
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
      return null;
    },

    async refreshTokens(credentials) {
      if (credentials.expires_at && new Date(credentials.expires_at) > new Date()) {
        return null;
      }
      return refreshClickUpToken(credentials);
    },
  };
}

async function* fetchTasksFromList(
  listId: string,
  spaceName: string,
  folderName: string | undefined,
  token: string,
  logger: Logger,
  accessScope?: SyncedItem["accessScope"],
  seenAssignees?: Map<string, { username: string; email?: string }>,
): AsyncGenerator<SyncedItem> {
  try {
    const tasksRes = (await clickupRequest(
      `/list/${listId}/task?include_subtasks=true&subtasks=true`,
      token,
      logger,
    )) as { tasks: ClickUpTask[] };

    for (const task of tasksRes.tasks) {
      if (seenAssignees) {
        for (const assignee of task.assignees) {
          if (assignee.username && !seenAssignees.has(assignee.username)) {
            seenAssignees.set(assignee.username, { username: assignee.username });
          }
        }
      }
      yield taskToSyncedItem(task, spaceName, folderName, accessScope);
    }
  } catch (err) {
    logger.warn({ err, listId }, "Failed to fetch tasks from list");
  }
}
