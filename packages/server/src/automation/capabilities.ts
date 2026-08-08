import { type AutomationSketchToolName, automationSketchToolNameSchema } from "@sketch/shared";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { type SearchUsersArgs, handleSearchUsers, searchUsersToolSchema } from "../agent/tools/messaging";
import {
  type GetEntityContextArgs,
  type SearchArgs,
  type SearchEntitiesArgs,
  getEntityContextToolSchema,
  handleGetEntityContext,
  handleSearch,
  handleSearchEntities,
  searchEntitiesToolSchema,
  searchToolSchema,
} from "../agent/tools/search";
import { type SearchableUserRepo, type SketchMcpDeps, type ToolResult, UploadCollector } from "../agent/tools/types";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";

const MAX_SEARCH_QUERY_LENGTH = 1000;
const MAX_SEARCH_LIMIT = 50;
const MAX_ENTITY_IDS = 100;
const MAX_ENTITY_ID_LENGTH = 200;
const MAX_ENTITY_QUERIES = 8;
const MAX_ENTITY_QUERY_LENGTH = 200;
const MAX_ENTITY_RESULTS = 100;
const MAX_TEAMMATE_QUERIES = 10;
const MAX_TEAMMATE_QUERY_LENGTH = 200;
const MAX_TEAMMATE_MATCHES = 20;
const MAX_TEXT_RESULT_LENGTH = 24_000;
export const MAX_AUTOMATION_OUTPUT_BYTES = 256 * 1024;

const automationSearchEntitySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    sourceType: z.string(),
    subtype: z.string().nullable(),
    aliases: z.array(z.string()),
    status: z.string(),
    hotness: z.number().optional(),
    source: z.string().optional(),
  })
  .passthrough();

const automationFindTeammateResultSchema = z
  .object({
    results: z.array(
      z.object({
        query: z.string(),
        matches: z.array(z.record(z.string(), z.unknown())),
      }),
    ),
  })
  .passthrough();

export interface AutomationCapabilityContext {
  taskId: string;
  runId: string;
  stepId: string;
  creatorId: string;
  creatorEmail: string | null;
  workspaceDir: string;
  db: Kysely<DB>;
  userRepo: SearchableUserRepo;
  logger: Logger;
  signal: AbortSignal;
  recordCall?: (event: AutomationCapabilityCallEvent) => void | Promise<void>;
  onFailure?: (capability: AutomationSketchToolName, error: unknown) => void;
}

export interface AutomationCapabilityCallEvent {
  taskId: string;
  runId: string;
  stepId: string;
  capability: AutomationSketchToolName;
  status: "completed" | "failed";
  durationMs: number;
}

export interface AutomationSearchEntity {
  id: string;
  name: string;
  sourceType: string;
  subtype: string | null;
  aliases: string[];
  status: string;
  hotness?: number;
  source?: string;
}

export interface AutomationFindTeammateResult {
  results: Array<{
    query: string;
    matches: Array<Record<string, unknown>>;
  }>;
}

export interface AutomationSketchTools {
  search?: (args: SearchArgs) => Promise<string>;
  searchEntities?: (args: SearchEntitiesArgs) => Promise<AutomationSearchEntity[]>;
  getEntityContext?: (args: GetEntityContextArgs) => Promise<string>;
  findTeammate?: (args: SearchUsersArgs) => Promise<AutomationFindTeammateResult>;
}

export interface AutomationCapabilityRegistry {
  createTools(params: {
    context: AutomationCapabilityContext;
    allowedTools: readonly AutomationSketchToolName[];
  }): Readonly<AutomationSketchTools>;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}

function boundedResultText(result: ToolResult): string {
  const text = resultText(result);
  if (text.length <= MAX_TEXT_RESULT_LENGTH) return text;
  return `${text.slice(0, MAX_TEXT_RESULT_LENGTH)}\n[Result truncated to ${MAX_TEXT_RESULT_LENGTH} characters.]`;
}

function parseJsonResult<T>(
  result: ToolResult,
  schema: { parse(value: unknown): T },
  fallback?: { text: string; value: T },
): T {
  const text = resultText(result);
  if (fallback && text === fallback.text) return fallback.value;
  if (Buffer.byteLength(text, "utf8") > MAX_AUTOMATION_OUTPUT_BYTES) {
    throw new Error(`Sketch capability output exceeds ${MAX_AUTOMATION_OUTPUT_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Sketch capability returned an unavailable or invalid response");
  }

  try {
    return schema.parse(parsed);
  } catch {
    throw new Error("Sketch capability returned an invalid response");
  }
}

function validateTextList(value: string[], name: string, maxItems: number, maxLength: number): string[] {
  if (value.length > maxItems) throw new Error(`${name} supports at most ${maxItems} values`);
  return value.map((item) => {
    const trimmed = item.trim();
    if (!trimmed) throw new Error(`${name} values cannot be empty`);
    if (trimmed.length > maxLength) throw new Error(`${name} values cannot exceed ${maxLength} characters`);
    return trimmed;
  });
}

function parseSearchArgs(value: SearchArgs): SearchArgs {
  const args = z.object(searchToolSchema).parse(value);
  if (args.query && args.query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search query cannot exceed ${MAX_SEARCH_QUERY_LENGTH} characters`);
  }
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit < 1)) {
    throw new Error("Search limit must be a positive number");
  }
  const entityId = args.entityId?.trim();
  if (entityId !== undefined && (!entityId || entityId.length > MAX_ENTITY_ID_LENGTH)) {
    throw new Error(`Entity id cannot be empty or exceed ${MAX_ENTITY_ID_LENGTH} characters`);
  }
  return {
    ...args,
    ...(args.query ? { query: args.query.trim() } : {}),
    ...(entityId ? { entityId } : {}),
    ...(args.entityIds
      ? { entityIds: validateTextList(args.entityIds, "Entity ids", MAX_ENTITY_IDS, MAX_ENTITY_ID_LENGTH) }
      : {}),
    ...(args.limit !== undefined ? { limit: Math.min(Math.floor(args.limit), MAX_SEARCH_LIMIT) } : {}),
  };
}

function parseSearchEntitiesArgs(value: SearchEntitiesArgs): SearchEntitiesArgs {
  const args = z.object(searchEntitiesToolSchema).parse(value);
  return {
    ...args,
    queries: validateTextList(args.queries, "Entity search", MAX_ENTITY_QUERIES, MAX_ENTITY_QUERY_LENGTH),
    ...(args.types ? { types: validateTextList(args.types, "Entity types", MAX_ENTITY_QUERIES, 80) } : {}),
  };
}

function parseGetEntityContextArgs(value: GetEntityContextArgs): GetEntityContextArgs {
  const args = z.object(getEntityContextToolSchema).parse(value);
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit < 1)) {
    throw new Error("Entity context limit must be a positive number");
  }
  const entityId = args.entityId.trim();
  if (!entityId || entityId.length > MAX_ENTITY_ID_LENGTH) {
    throw new Error(`Entity id cannot be empty or exceed ${MAX_ENTITY_ID_LENGTH} characters`);
  }
  return {
    ...args,
    entityId,
    ...(args.limit !== undefined ? { limit: Math.min(Math.floor(args.limit), MAX_SEARCH_LIMIT) } : {}),
  };
}

function parseSearchUsersArgs(value: SearchUsersArgs): SearchUsersArgs {
  const args = z.object(searchUsersToolSchema).parse(value);
  return {
    queries: validateTextList(args.queries, "Teammate search", MAX_TEAMMATE_QUERIES, MAX_TEAMMATE_QUERY_LENGTH),
  };
}

function createSketchDeps(context: AutomationCapabilityContext): SketchMcpDeps {
  return {
    uploadCollector: new UploadCollector(),
    workspaceDir: context.workspaceDir,
    db: context.db,
    userRepo: context.userRepo,
    currentUserId: context.creatorId,
    currentUserEmail: context.creatorEmail,
    publicMcp: { filterEntityMetadata: true },
    logger: context.logger,
  };
}

async function reportCall(context: AutomationCapabilityContext, event: AutomationCapabilityCallEvent): Promise<void> {
  try {
    if (context.recordCall) {
      await context.recordCall(event);
      return;
    }
    context.logger.info(event, "Automation Sketch capability call");
  } catch (error) {
    context.logger.warn({ err: error, capability: event.capability }, "Automation capability audit failed");
  }
}

async function invoke<T>(
  context: AutomationCapabilityContext,
  capability: AutomationSketchToolName,
  operation: () => Promise<T>,
): Promise<T> {
  if (context.signal.aborted) throw new Error(`Automation capability ${capability} was aborted`);
  const startedAt = Date.now();
  try {
    const result = await operation();
    if (context.signal.aborted) throw new Error(`Automation capability ${capability} was aborted`);
    await reportCall(context, {
      taskId: context.taskId,
      runId: context.runId,
      stepId: context.stepId,
      capability,
      status: "completed",
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    return result;
  } catch (error) {
    context.onFailure?.(capability, error);
    await reportCall(context, {
      taskId: context.taskId,
      runId: context.runId,
      stepId: context.stepId,
      capability,
      status: "failed",
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    throw error;
  }
}

export function createAutomationCapabilityRegistry(): AutomationCapabilityRegistry {
  return {
    createTools({ context, allowedTools }) {
      const parsedAllowedTools = automationSketchToolNameSchema.array().safeParse(allowedTools);
      if (!parsedAllowedTools.success) {
        throw new Error("Action step contains an unknown Sketch automation capability");
      }

      const allowed = new Set(parsedAllowedTools.data);
      const deps = createSketchDeps(context);
      const tools: AutomationSketchTools = {};

      if (allowed.has("search")) {
        tools.search = (value) =>
          invoke(context, "search", async () => boundedResultText(await handleSearch(parseSearchArgs(value), deps)));
      }
      if (allowed.has("searchEntities")) {
        tools.searchEntities = (value) =>
          invoke(context, "searchEntities", async () =>
            parseJsonResult<AutomationSearchEntity[]>(
              await handleSearchEntities(parseSearchEntitiesArgs(value), deps),
              automationSearchEntitySchema.array(),
              { text: "No entities found matching those queries.", value: [] },
            ).slice(0, MAX_ENTITY_RESULTS),
          );
      }
      if (allowed.has("getEntityContext")) {
        tools.getEntityContext = (value) =>
          invoke(context, "getEntityContext", async () =>
            boundedResultText(await handleGetEntityContext(parseGetEntityContextArgs(value), deps)),
          );
      }
      if (allowed.has("findTeammate")) {
        tools.findTeammate = (value) =>
          invoke(context, "findTeammate", async () => {
            const result = parseJsonResult<AutomationFindTeammateResult>(
              await handleSearchUsers(parseSearchUsersArgs(value), deps),
              automationFindTeammateResultSchema,
            );
            return {
              results: result.results.slice(0, MAX_TEAMMATE_QUERIES).map((entry) => ({
                query: entry.query,
                matches: entry.matches.slice(0, MAX_TEAMMATE_MATCHES),
              })),
            };
          });
      }

      return Object.freeze(tools);
    },
  };
}
