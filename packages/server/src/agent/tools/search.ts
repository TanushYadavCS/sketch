import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { resolveViewerPrincipals } from "../../access/principals";
import { KIND_TO_RULES, filterAccessibleFileIds, getFileContent, search } from "../../connectors/search";
import type { AccessPrincipal } from "../../connectors/types";
import type { DevSearchTraceOrigin, DevSearchTraceStatus } from "../../db/repositories/dev-search-traces";
import { createEntityRepository } from "../../db/repositories/entities";
import { createSearchTraceCapture } from "./search-trace";
import type { SketchMcpDeps, ToolResult } from "./types";

export const searchToolDescription = `Search across all indexed knowledge — docs, tasks, meetings, conversations, and workspace files. Uses hybrid search (keyword + semantic) for best results. Automatically surfaces matching entities for context.

When results mention a specific entity (project, client, person), results linked to that entity are boosted to the top. For hard-scoped search by entity, call SearchEntities first then pass the resolved IDs as \`entityIds\` (use \`entityIdsMode: "and"\` for "with X and Y", \`"or"\` for "from X or Y").

Recency: pass \`sortBy: "recency"\` for "latest", "most recent", "last X" questions. \`query\` is optional when filters are present (e.g. \`{ kind: "meeting", sortBy: "recency", limit: 3 }\` for "fetch my latest meeting" — RBAC scopes to what the user can see).

Use this to find information before asking others. Examples:
- "What did we decide about the auth approach?"  → Search({ query: "auth approach decision" })
- "Epik demo playbook"  → Search({ query: "Epik demo playbook" })
- "fetch my latest meeting"  → Search({ kind: "meeting", sortBy: "recency", limit: 3 })
- "latest meeting with Oliver Wyman and Ohoud"  → SearchEntities then Search({ kind: "meeting", entityIds: [<a>, <b>], sortBy: "recency" })
- "anything from Oliver or Ohoud lately"  → SearchEntities then Search({ entityIds: [<a>, <b>], entityIdsMode: "or", sortBy: "recency" })

\`kind\` cannot be combined with \`source: "local"\` (local files have no kind taxonomy).`;

export const searchToolSchema = {
  query: z.string().optional().describe("Natural language search query. May be empty when filters are present."),
  entityId: z.string().optional().describe("Back-compat single-entity hard filter. Prefer entityIds."),
  entityIds: z
    .array(z.string())
    .optional()
    .describe("Multi-entity filter. Pair with entityIdsMode. Use after SearchEntities."),
  entityIdsMode: z
    .enum(["and", "or"])
    .optional()
    .describe(
      "'and' (default): only files mentioning ALL entities. 'or': files mentioning ANY of them. If 'and' returns nothing, retry with 'or' before declaring no results.",
    ),
  kind: z
    .enum(["meeting", "doc", "task", "message"])
    .optional()
    .describe(
      "Semantic content kind. meeting=Fireflies, doc=Drive/Notion/ClickUp Docs/Linear projects, task=ClickUp tasks/Linear issues, message=conversation/WhatsApp/Slack.",
    ),
  source: z
    .enum(["google_drive", "clickup", "linear", "notion", "fireflies", "conversation", "whatsapp", "slack", "local"])
    .optional()
    .describe("Filter to a specific source. Omit to search all."),
  sortBy: z
    .enum(["relevance", "recency"])
    .optional()
    .describe("Use 'recency' for 'latest', 'most recent', 'last X' questions. Default is 'relevance'."),
  after: z.string().optional().describe("Only results updated after this ISO date"),
  before: z.string().optional().describe("Only results updated before this ISO date"),
  limit: z.number().optional().describe("Max results (default 10; default 3 when sortBy=recency)."),
};

export const searchEntitiesToolDescription = `Search for entities (projects, people, teams, companies, products) across all connected sources. Accepts multiple query variations to catch abbreviations and informal names. Returns matched entities with their type, status, and mention count.

Use this when the user asks about a project, person, or any named thing tracked across the org's tools. Pass multiple name variations (e.g. ["Beetu", "B2", "beetu app"]) to maximize matches.`;

export const searchEntitiesToolSchema = {
  queries: z
    .array(z.string())
    .describe("Array of name variations to search for. Runs substring match per query, dedupes results."),
  types: z
    .array(z.string())
    .optional()
    .describe(
      "Filter by entity source_type. Examples: 'person', 'clickup_space', 'clickup_folder', 'linear_project', 'notion_database'.",
    ),
};

export const getEntityContextToolDescription = `Get cross-source context for an entity — all recent mentions across meetings, tasks, docs, and other indexed content. Returns a formatted timeline showing where and when this entity was referenced.

Use this after SearchEntities to dive deeper into a specific entity. The response is a human-readable summary, not raw data.`;

export const getEntityContextToolSchema = {
  entityId: z.string().describe("The entity ID from SearchEntities results."),
  limit: z.number().optional().describe("Max mentions to return. Default 20. Agent can request more if needed."),
  since: z
    .string()
    .optional()
    .describe("ISO date string. Only return mentions after this date. Example: '2026-03-01'."),
};

export const getFileContentToolDescription = `Retrieve the full content of an indexed file by its ID. Use this after Search returns a relevant result and you need the complete text — e.g. full meeting transcript, complete document, or full task description.

The ID comes from a previous Search result.`;

export const getFileContentToolSchema = {
  fileId: z.string().describe("The indexed file ID from a Search result."),
};

export type SearchArgs = z.infer<z.ZodObject<typeof searchToolSchema>>;
export type SearchEntitiesArgs = z.infer<z.ZodObject<typeof searchEntitiesToolSchema>>;
export type GetEntityContextArgs = z.infer<z.ZodObject<typeof getEntityContextToolSchema>>;
export type GetFileContentArgs = z.infer<z.ZodObject<typeof getFileContentToolSchema>>;

export { resolveViewerPrincipals } from "../../access/principals";

export async function resolveUserPrincipals(deps: SketchMcpDeps): Promise<AccessPrincipal[]> {
  return resolveViewerPrincipals(deps);
}

async function filterEntityRowsForPublic<
  T extends { id: string; source_type: string; subtype: string | null; aliases: string | null },
>(deps: SketchMcpDeps, rows: T[]): Promise<T[]> {
  if (!deps.publicMcp?.filterEntityMetadata || !deps.db || rows.length === 0) return rows;

  const userPrincipals = await resolveUserPrincipals(deps);
  if (userPrincipals.length === 0) return [];

  const mentions = await deps.db
    .selectFrom("entity_mentions")
    .select(["entity_id", "indexed_file_id"])
    .where(
      "entity_id",
      "in",
      rows.map((row) => row.id),
    )
    .execute();

  const accessibleIds = await filterAccessibleFileIds(
    deps.db,
    mentions.map((mention) => mention.indexed_file_id),
    userPrincipals,
    deps.slackEntitySyncEnabled ?? true,
  );
  const visibleEntityIds = new Set(
    mentions.filter((mention) => accessibleIds.has(mention.indexed_file_id)).map((mention) => mention.entity_id),
  );

  return rows.filter((row) => visibleEntityIds.has(row.id));
}

function parseAliases(value: string | null): string[] {
  return value ? (JSON.parse(value) as string[]) : [];
}

function displayEntitySubtype(sourceType: string, subtype: string | null): string | null {
  if (sourceType !== "person") return subtype;
  return subtype === "internal" ? "internal" : "external";
}

export async function handleSearch(
  {
    query: searchQuery,
    entityId,
    entityIds,
    entityIdsMode,
    kind,
    source,
    sortBy,
    after,
    before,
    limit: resultLimit,
  }: SearchArgs,
  deps: SketchMcpDeps,
  origin: DevSearchTraceOrigin = "agent",
): Promise<ToolResult> {
  if (!deps.db) {
    return { content: [{ type: "text", text: "Search not available." }] };
  }

  const trace = createSearchTraceCapture({
    deps,
    origin,
    query: (searchQuery ?? "").trim(),
    toolArgs: {
      query: searchQuery,
      entityId,
      entityIds,
      entityIdsMode,
      kind,
      source,
      sortBy,
      after,
      before,
      limit: resultLimit,
    },
    principals: null,
  });
  const stageReport = trace?.report;

  /**
   * Every exit path records a trace, including the ones that return before any stage ran.
   * A search that returned nothing is exactly the call someone opens the feed to debug, so
   * omitting it would hide the interesting half of the traffic.
   */
  const done = (
    status: DevSearchTraceStatus,
    text: string,
    resultCount = 0,
    error: string | null = null,
  ): ToolResult => {
    trace?.finish(status, error, resultCount);
    return { content: [{ type: "text", text }] };
  };

  if (kind && source === "local") {
    return done(
      "empty",
      "kind cannot be combined with source: 'local' (local files have no kind taxonomy).",
      0,
      "kind combined with source: local",
    );
  }

  const trimmedQuery = (searchQuery ?? "").trim();
  const callerProvidedEntityIds = !!(entityId || (entityIds && entityIds.length > 0));
  const hasFilter = !!kind || !!source || callerProvidedEntityIds || !!after || !!before;

  if (!trimmedQuery && !hasFilter) {
    return done(
      "empty",
      "Need a query or at least one filter (kind, source, entityIds, after, before).",
      0,
      "no query and no filter",
    );
  }

  const lines: string[] = [];
  const entityRepo = createEntityRepository(deps.db);

  type EntityRow = Awaited<ReturnType<typeof entityRepo.searchEntities>>[number];
  let entityMatches: EntityRow[] = [];
  const skipAutoEntityBoost = callerProvidedEntityIds || trimmedQuery === "";
  if (!skipAutoEntityBoost) {
    entityMatches = await entityRepo.searchEntities(trimmedQuery, { limit: 5 });
  } else if (callerProvidedEntityIds) {
    const ids = entityIds && entityIds.length > 0 ? entityIds : entityId ? [entityId] : [];
    entityMatches = await entityRepo.getEntities(ids);
  }
  entityMatches = await filterEntityRowsForPublic(deps, entityMatches);

  if (entityMatches.length > 0) {
    const entityParts = entityMatches.map((e) => {
      const aliases = parseAliases(e.aliases);
      const aliasStr = aliases.length > 0 ? `, aliases: ${aliases.join(", ")}` : "";
      const subtype = displayEntitySubtype(e.source_type, e.subtype);
      const subtypeStr = subtype ? ` (${subtype})` : "";
      return `${e.name} (${e.id}) [${e.source_type}${subtypeStr}${aliasStr}]`;
    });
    lines.push(`**Matching entities**: ${entityParts.join(" | ")}`);
    lines.push("");
  }

  let entityFileIds: Set<string> | undefined;
  if (!skipAutoEntityBoost && entityMatches.length > 0) {
    const matchIds = entityMatches.map((e) => e.id);
    const mentions = await deps.db
      .selectFrom("entity_mentions")
      .select("indexed_file_id")
      .where("entity_id", "in", matchIds)
      .execute();
    entityFileIds = new Set(mentions.map((m) => m.indexed_file_id));
  }

  const effectiveLimit = resultLimit ?? (sortBy === "recency" ? 3 : 10);
  const userPrincipals = await resolveUserPrincipals(deps);
  if (deps.publicMcp && userPrincipals.length === 0) {
    const label = trimmedQuery ? `"${trimmedQuery}"` : "the given filters";
    return done("empty", `No results found for ${label}.`, 0, "public MCP caller resolved to no principals");
  }
  const results = await search(deps.db, trimmedQuery, {
    stageReport,
    kindRules: kind ? KIND_TO_RULES[kind] : undefined,
    source,
    limit: effectiveLimit,
    after,
    before,
    entityId,
    entityIds,
    entityIdsMode,
    sortBy,
    userPrincipals,
    slackEntitySyncEnabled: deps.slackEntitySyncEnabled,
    skipAutoEntityBoost,
    geminiMaxRpm: deps.geminiConfig?.maxRpm,
    geminiMaxRetries: deps.geminiConfig?.maxRetries,
    openRouterApiKey: deps.openRouterApiKey,
    settingsEncryptionKey: deps.settingsEncryptionKey,
    logger: deps.logger,
  });

  const effectiveSortBy = sortBy ?? "relevance";
  const rerankApplied =
    effectiveSortBy === "relevance" && !callerProvidedEntityIds && !!entityFileIds && entityFileIds.size > 0;
  if (rerankApplied) {
    results.sort((a, b) => {
      const aLinked = entityFileIds?.has(a.id) ? 1 : 0;
      const bLinked = entityFileIds?.has(b.id) ? 1 : 0;
      if (aLinked !== bLinked) return bLinked - aLinked;
      return b.score - a.score;
    });
  }
  trace?.rerank(results, rerankApplied, entityFileIds?.size ?? 0);

  if (results.length === 0 && entityMatches.length === 0) {
    const label = trimmedQuery ? `"${trimmedQuery}"` : "the given filters";
    return done("empty", `No results found for ${label}.`, 0, null);
  }

  for (const r of results) {
    const sourceLabel = r.source.charAt(0).toUpperCase() + r.source.slice(1).replace(/_/g, " ");
    const date = r.sourceUpdatedAt ? new Date(r.sourceUpdatedAt).toISOString().split("T")[0] : "";

    lines.push(`**${r.fileName}** (${sourceLabel}${date ? `, ${date}` : ""})`);
    lines.push(`  sketchId: ${r.id}`);
    lines.push(`  providerId: ${r.providerFileId} (source=${r.source})`);
    if (r.providerUrl) lines.push(`  url: ${r.providerUrl}`);
    if (r.summary) {
      lines.push(`> ${r.summary.slice(0, 200)}${r.summary.length > 200 ? "..." : ""}`);
    } else if (r.snippet) {
      lines.push(`> ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`);
    }
    lines.push("");
  }

  return done("done", lines.join("\n"), results.length);
}

export async function handleSearchEntities(
  { queries, types }: SearchEntitiesArgs,
  deps: SketchMcpDeps,
): Promise<ToolResult> {
  if (!deps.db) {
    return { content: [{ type: "text", text: "Entity search not available." }] };
  }
  const entityRepo = createEntityRepository(deps.db);
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const query of queries) {
    const matches = await filterEntityRowsForPublic(
      deps,
      await entityRepo.searchEntities(query, {
        sourceTypes: types,
        limit: 20,
      }),
    );
    for (const entity of matches) {
      if (!seen.has(entity.id)) {
        seen.add(entity.id);
        results.push({
          id: entity.id,
          name: entity.name,
          sourceType: entity.source_type,
          subtype: displayEntitySubtype(entity.source_type, entity.subtype),
          aliases: parseAliases(entity.aliases),
          status: entity.status,
          hotness: entity.hotness,
        });
      }
    }
  }

  if (results.length === 0 && !deps.publicMcp && deps.userRepo) {
    const users = await deps.userRepo.list();
    for (const query of queries) {
      const q = query.toLowerCase();
      for (const user of users) {
        if (user.name.toLowerCase().includes(q) && !seen.has(user.id)) {
          seen.add(user.id);
          results.push({
            id: user.id,
            name: user.name,
            sourceType: "person",
            subtype: "internal",
            aliases: [],
            status: "confirmed",
            source: "team_directory",
          });
        }
      }
    }
  }

  if (results.length === 0) {
    return { content: [{ type: "text", text: "No entities found matching those queries." }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

export async function handleGetEntityContext(
  { entityId, limit, since }: GetEntityContextArgs,
  deps: SketchMcpDeps,
): Promise<ToolResult> {
  if (!deps.db) {
    return { content: [{ type: "text", text: "Entity context not available." }] };
  }
  const entityRepo = createEntityRepository(deps.db);
  const entity = await entityRepo.getEntity(entityId);
  if (!entity) {
    return { content: [{ type: "text", text: `Entity ${entityId} not found.` }] };
  }

  const requestedLimit = limit ?? 20;
  const userPrincipals = await resolveUserPrincipals(deps);
  if (userPrincipals.length === 0) {
    return { content: [{ type: "text", text: "No mentions found for this entity." }] };
  }
  const rawMentions = await entityRepo.getMentionsForEntity(entityId, {
    limit: Math.max(requestedLimit * 5, 100),
    since,
  });

  const accessibleIds = await filterAccessibleFileIds(
    deps.db,
    rawMentions.map((m) => m.indexed_file_id),
    userPrincipals,
    deps.slackEntitySyncEnabled ?? true,
  );

  const mentions = rawMentions.filter((m) => accessibleIds.has(m.indexed_file_id)).slice(0, requestedLimit);

  if (deps.publicMcp?.filterEntityMetadata && mentions.length === 0) {
    return { content: [{ type: "text", text: `Entity ${entityId} not found.` }] };
  }

  const lines: string[] = [];
  const aliases = parseAliases(entity.aliases);
  const aliasStr = aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
  const subtype = displayEntitySubtype(entity.source_type, entity.subtype);
  lines.push(`## ${entity.name}${aliasStr}`);
  lines.push(`Type: ${entity.source_type}${subtype ? ` (${subtype})` : ""} | Status: ${entity.status}`);
  lines.push(
    `Total mentions found: ${mentions.length}${mentions.length === requestedLimit ? " (limit reached, use 'since' or increase 'limit' for more)" : ""}`,
  );
  lines.push("");

  for (const mention of mentions) {
    const file = await deps.db
      .selectFrom("indexed_files")
      .select(["file_name", "file_type", "source", "source_path", "provider_url"])
      .where("id", "=", mention.indexed_file_id)
      .executeTakeFirst();

    if (!file) continue;

    const sourceDate = mention.source_updated_at ?? mention.source_created_at ?? mention.mentioned_at;
    const date = new Date(sourceDate).toISOString().split("T")[0];
    const sourceLabel = file.source.charAt(0).toUpperCase() + file.source.slice(1);
    const urlSuffix = file.provider_url ? ` (${file.provider_url})` : "";
    lines.push(`**${date}** — ${sourceLabel}: "${file.file_name}"${urlSuffix}`);
    if (mention.context_snippet) {
      lines.push(`  ${mention.context_snippet.slice(0, 200)}`);
    }
    lines.push("");
  }

  if (mentions.length === 0) {
    lines.push("No mentions found for this entity.");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleGetFileContent({ fileId }: GetFileContentArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  if (!deps.db) {
    return { content: [{ type: "text", text: "File content not available." }] };
  }
  const userPrincipals = await resolveUserPrincipals(deps);
  if (deps.publicMcp && userPrincipals.length === 0) {
    return { content: [{ type: "text", text: `File ${fileId} not found.` }] };
  }
  const file = await getFileContent(deps.db, fileId, userPrincipals, deps.slackEntitySyncEnabled ?? true);

  if (!file) {
    return { content: [{ type: "text", text: `File ${fileId} not found.` }] };
  }

  const lines: string[] = [];
  const sourceLabel = file.source.charAt(0).toUpperCase() + file.source.slice(1).replace(/_/g, " ");
  lines.push(`# ${file.fileName}`);
  lines.push(`Source: ${sourceLabel}${file.fileType ? ` (${file.fileType})` : ""}`);
  if (file.providerUrl) lines.push(`URL: ${file.providerUrl}`);
  lines.push("");

  const fullContent = file.content ?? file.summary ?? "(no content)";
  const maxChars = deps.publicMcp?.maxFileContentChars;
  if (maxChars && fullContent.length > maxChars) {
    lines.push(fullContent.slice(0, maxChars));
    lines.push("");
    lines.push(`[Content truncated to ${maxChars} characters.]`);
  } else {
    lines.push(fullContent);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export function createSearchTools(deps: SketchMcpDeps) {
  return [
    tool("Search", searchToolDescription, searchToolSchema, (args) => handleSearch(args, deps)),
    tool("SearchEntities", searchEntitiesToolDescription, searchEntitiesToolSchema, (args) =>
      handleSearchEntities(args, deps),
    ),
    tool("GetEntityContext", getEntityContextToolDescription, getEntityContextToolSchema, (args) =>
      handleGetEntityContext(args, deps),
    ),
    tool("GetFileContent", getFileContentToolDescription, getFileContentToolSchema, (args) =>
      handleGetFileContent(args, deps),
    ),
  ];
}
