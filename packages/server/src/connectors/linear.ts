/**
 * Linear connector.
 *
 * Uses Linear's GraphQL API via direct HTTP calls.
 * Auth: API key (personal or workspace) or OAuth.
 *
 * Sync strategy:
 * - Full: paginate all issues, projects, and comments
 * - Incremental: filter by updatedAt >= lastSyncTimestamp
 * - Issues stored with title, description, metadata (status, assignee, labels, etc.)
 * - Projects stored as documents with description content
 *
 * Linear's API uses cursor-based pagination (first/after) and supports
 * efficient filtering via `updatedAt: { gte: timestamp }`.
 */
import { createHash } from "node:crypto";
import pino, { type Logger } from "pino";
import { qualifyContainerName } from "./container-name";
import type { Connector, ConnectorCredentials, EntitySeedCallback, OAuthCredentials, SyncedItem } from "./types";

const LINEAR_API = "https://api.linear.app/graphql";
const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";

/**
 * Max items per GraphQL page. Kept at 25 (not 50) because the issues query
 * fans out into nested `comments`/`labels` connections; at 50 the per-page
 * GraphQL complexity exceeds Linear's 10000 ceiling and the API rejects it.
 */
const PAGE_SIZE = 25;

/** Rate limit: ~1,500 req/hour, we stay conservative at ~20 req/s. */
const MIN_REQUEST_INTERVAL_MS = 50;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  state: { name: string; type: string } | null;
  priority: number;
  priorityLabel: string;
  assignee: { id: string; name: string; displayName: string; email: string | null } | null;
  labels: { nodes: Array<{ name: string }> };
  team: { id: string; name: string; key: string } | null;
  project: { id: string; name: string } | null;
  estimate: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  comments: { nodes: Array<{ body: string; user: { name: string } | null; createdAt: string }> };
}

interface LinearProject {
  id: string;
  name: string;
  description?: string | null;
  url: string;
  state: string;
  lead: { name: string; displayName: string } | null;
  startDate: string | null;
  targetDate: string | null;
  teams: { nodes: Array<{ name: string; key: string }> };
  createdAt: string;
  updatedAt: string;
}

interface LinearMember {
  id: string;
  name: string;
  email: string | null;
}

interface LinearTeam {
  id: string;
  name: string;
  key: string;
  members: { pageInfo?: PageInfo; nodes: LinearMember[] };
}

interface GraphQLResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

function getAccessToken(credentials: ConnectorCredentials): string {
  if (credentials.type === "api_key") return credentials.api_key;
  if (credentials.type === "oauth") return credentials.access_token;
  throw new Error("Linear connector requires api_key or oauth credentials");
}

function makeLinearRequest(getLastRequestTime: () => number, setLastRequestTime: (t: number) => void) {
  return async function linearRequest<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
    logger: Logger,
    attempt = 1,
  ): Promise<T> {
    const now = Date.now();
    const elapsed = now - getLastRequestTime();
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    setLastRequestTime(Date.now());

    let response: Response;
    try {
      response = await fetch(LINEAR_API, {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
      const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        logger.warn({ attempt, detail, waitMs }, "Linear network error, retrying");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return linearRequest(query, variables, token, logger, attempt + 1);
      }

      throw new Error(`Linear API network error after ${MAX_RETRIES} attempts: ${detail}`);
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Linear API rate limited after ${MAX_RETRIES} attempts`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 10_000;
      logger.debug({ waitMs }, "Rate limited, waiting");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return linearRequest(query, variables, token, logger, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Linear API failed (${response.status}): ${body}`);
    }

    const result = (await response.json()) as GraphQLResponse<T>;

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Linear GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`);
    }

    return result.data;
  };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/**
 * Builds the issue's indexed document. The `parentEntities` references link
 * issues to their seeded Linear team and, when present, project entities using
 * the bare Linear object ids emitted by the seed pass.
 */
function issueToSyncedItem(issue: LinearIssue): SyncedItem {
  const hasDescription = issue.description && issue.description.trim().length > 0;

  const metadata = [
    issue.state ? `Status: ${issue.state.name}` : null,
    `Priority: ${issue.priorityLabel || PRIORITY_LABELS[issue.priority] || "None"}`,
    issue.assignee ? `Assignee: ${issue.assignee.displayName}` : null,
    issue.labels.nodes.length > 0 ? `Labels: ${issue.labels.nodes.map((l) => l.name).join(", ")}` : null,
    issue.team ? `Team: ${issue.team.name}` : null,
    issue.project ? `Project: ${issue.project.name}` : null,
    issue.estimate != null ? `Estimate: ${issue.estimate}` : null,
    issue.dueDate ? `Due: ${issue.dueDate}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const parts = [`${issue.identifier}: ${issue.title}`, metadata];

  if (hasDescription) {
    parts.push(issue.description as string);
  }

  if (issue.comments.nodes.length > 0) {
    const commentText = issue.comments.nodes.map((c) => `[${c.user?.name ?? "Unknown"}] ${c.body}`).join("\n\n");
    parts.push(`--- Comments ---\n${commentText}`);
  }

  const content = parts.join("\n\n");
  const sourcePath = [issue.team?.name, issue.project?.name].filter(Boolean).join(" / ");

  return {
    providerFileId: issue.id,
    providerUrl: issue.url,
    fileName: `${issue.identifier}: ${issue.title}`,
    fileType: "issue",
    contentCategory: hasDescription ? "document" : "structured",
    content,
    sourcePath: sourcePath || null,
    contentHash: contentHash(content),
    sourceCreatedAt: issue.createdAt,
    sourceUpdatedAt: issue.updatedAt,
    assignees: issue.assignee
      ? [
          {
            name: issue.assignee.displayName,
            email: issue.assignee.email ?? undefined,
            source: "linear",
            sourceId: issue.assignee.id,
          },
        ]
      : [],
    task: {
      sourceTaskId: issue.id,
      externalRef: issue.identifier,
      title: issue.title,
      statusType: issue.state?.type ?? "unstarted",
      statusRaw: issue.state?.name,
      priority: issue.priorityLabel || PRIORITY_LABELS[issue.priority] || undefined,
      dueAt: issue.dueDate ?? undefined,
      project: issue.project
        ? {
            name: qualifyContainerName(issue.project.name, issue.team?.name ?? null),
            source: "linear",
            sourceId: issue.project.id,
          }
        : undefined,
      assignee: issue.assignee
        ? {
            name: issue.assignee.displayName,
            email: issue.assignee.email ?? undefined,
            source: "linear",
            sourceId: issue.assignee.id,
          }
        : undefined,
    },
    parentEntities: [
      ...(issue.team
        ? [{ source: "linear", sourceId: issue.team.id, contextSnippet: `Linear issue in team: ${issue.team.name}` }]
        : []),
      ...(issue.project
        ? [
            {
              source: "linear",
              sourceId: issue.project.id,
              contextSnippet: `Linear issue in project: ${issue.project.name}`,
            },
          ]
        : []),
    ],
    // TODO: populate access scope from team membership + privacy
  };
}

/**
 * Builds the project's indexed document. The `parentEntities` self-reference
 * links this doc to the seeded `project` entity (sourceId is the bare project
 * id, matching `emitLinearProjectSeed`), so the entity carries its own document
 * as evidence. The `parent_entity` fact materializes after the project seed,
 * which creates the entity first (`FACT_REPLAY_ORDER`).
 */
function projectToSyncedItem(project: LinearProject): SyncedItem {
  const hasDescription = project.description && project.description.trim().length > 0;

  const metadata = [
    `State: ${project.state}`,
    project.lead ? `Lead: ${project.lead.displayName}` : null,
    project.teams.nodes.length > 0 ? `Teams: ${project.teams.nodes.map((t) => t.name).join(", ")}` : null,
    project.startDate ? `Start: ${project.startDate}` : null,
    project.targetDate ? `Target: ${project.targetDate}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const content = hasDescription
    ? `${project.name}\n\n${metadata}\n\n${project.description}`
    : `${project.name}\n\n${metadata}`;

  return {
    providerFileId: `project-${project.id}`,
    providerUrl: project.url,
    fileName: project.name,
    fileType: "project",
    contentCategory: hasDescription ? "document" : "structured",
    content,
    sourcePath: null,
    contentHash: contentHash(content),
    sourceCreatedAt: project.createdAt,
    sourceUpdatedAt: project.updatedAt,
    parentEntities: [{ source: "linear", sourceId: project.id, contextSnippet: `Linear project: ${project.name}` }],
    // TODO: populate access scope from team membership + privacy
  };
}

/**
 * Builds the team's indexed document and carries membership facts. The team
 * entity is still emitted through the structural seed callback because Linear
 * team files are not promotable, while member people and relationships can use
 * the yielded document's fact pipeline.
 */
function teamToSyncedItem(team: LinearTeam): SyncedItem {
  const memberNames = team.members.nodes.map((member) => member.name).join(", ");
  const content = `${team.name}\n\nMembers: ${memberNames}`;

  return {
    providerFileId: `team-${team.id}`,
    providerUrl: null,
    fileName: team.name,
    fileType: "team",
    contentCategory: "structured",
    content,
    sourcePath: null,
    contentHash: contentHash(content),
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    personSeeds: team.members.nodes.map((member) => ({
      name: member.name,
      email: member.email ?? undefined,
      subtype: "internal",
      source: "linear",
      sourceId: member.id,
    })),
    relationships: team.members.nodes.map((member) => ({
      relationType: "member_of",
      source: { source: "linear", sourceId: member.id, name: member.name, type: "person" },
      target: { source: "linear", sourceId: team.id, name: team.name, type: "team" },
      contextSnippet: `Member of ${team.name}`,
    })),
  };
}

async function refreshLinearToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Linear token refresh failed (${response.status}): ${body}`);
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

const ISSUES_QUERY = `
query Issues($first: Int!, $after: String, $filter: IssueFilter) {
	issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
		pageInfo {
			hasNextPage
			endCursor
		}
		nodes {
			id
			identifier
			title
			description
			url
			state { name type }
			priority
			priorityLabel
			assignee { id name displayName email }
			labels(first: 20) { nodes { name } }
			team { id name key }
			project { id name }
			estimate
			dueDate
			createdAt
			updatedAt
			comments(first: 10) {
				nodes {
					body
					user { name }
					createdAt
				}
			}
		}
	}
}`;

const PROJECTS_QUERY = `
query Projects($first: Int!, $after: String, $filter: ProjectFilter) {
	projects(first: $first, after: $after, filter: $filter) {
		pageInfo {
			hasNextPage
			endCursor
		}
		nodes {
			id
			name
			description
			url
			state
			lead { name displayName }
			startDate
			targetDate
			teams { nodes { name key } }
			createdAt
			updatedAt
		}
	}
}`;

const TEAMS_QUERY = `
query Teams($first: Int!, $after: String) {
	teams(first: $first, after: $after) {
		pageInfo {
			hasNextPage
			endCursor
		}
		nodes {
			id
			name
			key
			members(first: 50) {
				pageInfo {
					hasNextPage
					endCursor
				}
				nodes { id name email }
			}
		}
	}
}`;

const TEAM_MEMBERS_QUERY = `
query TeamMembers($teamId: String!, $first: Int!, $after: String) {
	team(id: $teamId) {
		members(first: $first, after: $after) {
			pageInfo {
				hasNextPage
				endCursor
			}
			nodes { id name email }
		}
	}
}`;

/**
 * Linear does not currently emit accessScope/accessPrincipals, so seeded Linear
 * entities inherit org-wide visibility until Linear connector hardening lands.
 */
async function emitLinearProjectSeed(project: LinearProject, onEntitySeed: EntitySeedCallback): Promise<void> {
  const teams = project.teams.nodes.map((team) => team.name);
  const name = qualifyContainerName(project.name, teams.length === 1 ? teams[0] : null);
  await onEntitySeed({
    name,
    sourceType: "project",
    source: "linear",
    sourceId: project.id,
    sourceUrl: project.url,
    aliases: name === project.name ? undefined : [project.name],
    metadata: {
      state: project.state,
      lead: project.lead?.displayName ?? null,
      teams,
      startDate: project.startDate,
      targetDate: project.targetDate,
    },
  });
}

export function createLinearConnector(): Connector {
  // Per-connector instance rate limiter state — not shared across concurrent syncs
  let lastRequestTime = 0;
  const linearRequest = makeLinearRequest(
    () => lastRequestTime,
    (t) => {
      lastRequestTime = t;
    },
  );

  return {
    type: "linear",
    perUserAuth: false,
    requiresOAuthClientSetup: false,
    promotableFileTypes: [],

    async validateCredentials(credentials) {
      const token = getAccessToken(credentials);
      const query = "query { viewer { id name } }";
      await linearRequest(query, {}, token, pino({ level: "silent" }));
    },

    async *sync({ credentials, scopeConfig, cursor, logger, onEntitySeed }) {
      const token = getAccessToken(credentials);
      const allowedTeams = (scopeConfig.teams as string[] | undefined) ?? [];
      const sinceDate = cursor ?? null;

      yield* syncIssues(token, sinceDate, allowedTeams, logger, linearRequest);
      yield* syncTeams(token, allowedTeams, logger, linearRequest, onEntitySeed);
      yield* syncProjects(token, sinceDate, logger, linearRequest, onEntitySeed);
    },

    async getCursor({ currentCursor }) {
      return new Date().toISOString();
    },

    async refreshTokens(credentials) {
      if (credentials.expires_at && new Date(credentials.expires_at) > new Date()) {
        return null;
      }
      return refreshLinearToken(credentials);
    },
  };
}

type LinearRequestFn = ReturnType<typeof makeLinearRequest>;

async function* syncIssues(
  token: string,
  since: string | null,
  allowedTeams: string[],
  logger: Logger,
  linearRequest: LinearRequestFn,
): AsyncGenerator<SyncedItem> {
  let afterCursor: string | null = null;
  let totalIssues = 0;

  const filter: Record<string, unknown> = {};
  if (since) {
    filter.updatedAt = { gte: since };
  }
  if (allowedTeams.length > 0) {
    filter.team = { key: { in: allowedTeams } };
  }

  do {
    const variables: Record<string, unknown> = {
      first: PAGE_SIZE,
      after: afterCursor,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    };

    const data = await linearRequest<{
      issues: { pageInfo: PageInfo; nodes: LinearIssue[] };
    }>(ISSUES_QUERY, variables, token, logger);

    for (const issue of data.issues.nodes) {
      yield issueToSyncedItem(issue);
      totalIssues++;
    }

    afterCursor = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    logger.debug({ issuesProcessed: totalIssues, hasMore: !!afterCursor }, "Issues page complete");
  } while (afterCursor);

  logger.info({ totalIssues }, "Issues sync complete");
}

async function* syncProjects(
  token: string,
  since: string | null,
  logger: Logger,
  linearRequest: LinearRequestFn,
  onEntitySeed?: EntitySeedCallback,
): AsyncGenerator<SyncedItem> {
  let afterCursor: string | null = null;
  let totalProjects = 0;

  const filter: Record<string, unknown> = {};
  if (since) {
    filter.updatedAt = { gte: since };
  }

  do {
    const variables: Record<string, unknown> = {
      first: PAGE_SIZE,
      after: afterCursor,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    };

    const data = await linearRequest<{
      projects: { pageInfo: PageInfo; nodes: LinearProject[] };
    }>(PROJECTS_QUERY, variables, token, logger);

    for (const project of data.projects.nodes) {
      yield projectToSyncedItem(project);
      if (onEntitySeed) {
        await emitLinearProjectSeed(project, onEntitySeed);
      }
      totalProjects++;
    }

    afterCursor = data.projects.pageInfo.hasNextPage ? data.projects.pageInfo.endCursor : null;
    logger.debug({ projectsProcessed: totalProjects, hasMore: !!afterCursor }, "Projects page complete");
  } while (afterCursor);

  logger.info({ totalProjects }, "Projects sync complete");
}

/**
 * Fetches any team members beyond the first nested page. The top-level teams
 * query embeds the first {@link PAGE_SIZE}-capped page of members; large teams
 * are completed here so every member gets a `person_seed` fact and `member_of`
 * edge, mirroring the cursor loop used for the teams connection itself.
 */
async function fetchRemainingTeamMembers(
  token: string,
  teamId: string,
  initialPageInfo: PageInfo,
  logger: Logger,
  linearRequest: LinearRequestFn,
): Promise<LinearMember[]> {
  const members: LinearMember[] = [];
  let afterCursor: string | null = initialPageInfo.hasNextPage ? initialPageInfo.endCursor : null;

  while (afterCursor) {
    const data = await linearRequest<{
      team: { members: { pageInfo: PageInfo; nodes: LinearMember[] } } | null;
    }>(TEAM_MEMBERS_QUERY, { teamId, first: 250, after: afterCursor }, token, logger);

    const page = data.team?.members;
    if (!page) break;

    members.push(...page.nodes);
    afterCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  }

  return members;
}

async function* syncTeams(
  token: string,
  allowedTeams: string[],
  logger: Logger,
  linearRequest: LinearRequestFn,
  onEntitySeed?: EntitySeedCallback,
): AsyncGenerator<SyncedItem> {
  let afterCursor: string | null = null;
  let totalTeams = 0;

  const allowedTeamKeys = allowedTeams.length > 0 ? new Set(allowedTeams) : null;

  do {
    const variables: Record<string, unknown> = {
      first: PAGE_SIZE,
      after: afterCursor,
    };

    const data = await linearRequest<{
      teams: { pageInfo: PageInfo; nodes: LinearTeam[] };
    }>(TEAMS_QUERY, variables, token, logger);

    for (const team of data.teams.nodes) {
      if (allowedTeamKeys && !allowedTeamKeys.has(team.key)) {
        continue;
      }

      if (team.members.pageInfo?.hasNextPage) {
        const remaining = await fetchRemainingTeamMembers(token, team.id, team.members.pageInfo, logger, linearRequest);
        team.members.nodes.push(...remaining);
      }

      if (onEntitySeed) {
        await onEntitySeed({
          name: team.name,
          sourceType: "team",
          source: "linear",
          sourceId: team.id,
          metadata: { key: team.key },
        });
      }
      yield teamToSyncedItem(team);
      totalTeams++;
    }

    afterCursor = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null;
    logger.debug({ teamsProcessed: totalTeams, hasMore: !!afterCursor }, "Teams page complete");
  } while (afterCursor);

  logger.info({ totalTeams }, "Teams sync complete");
}
