import { tool } from "@anthropic-ai/claude-agent-sdk";
import { sql } from "kysely";
import { z } from "zod/v4";
import { authorizedTargets } from "../../access/membership";
import { resolveViewerPrincipals } from "../../access/principals";
import type { SketchMcpDeps, ToolResult } from "./types";

const searchDeliveryTargetsSchema = {
  query: z
    .string()
    .optional()
    .describe("Optional target name to search, such as 'engineering', 'ops', or a person name/email."),
  platform: z.enum(["slack", "whatsapp"]).optional().describe("Optional platform filter."),
  targetType: z.enum(["channel", "dm", "group"]).optional().describe("Optional target type filter."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return. Defaults to 10."),
  cursor: z.string().optional().describe("Cursor from a previous response to fetch the next page."),
};

type DeliveryPlatformFilter = "slack" | "whatsapp";
type DeliveryTargetTypeFilter = "channel" | "dm" | "group";

interface DeliveryTargetMatch {
  platform: DeliveryPlatformFilter;
  targetType: DeliveryTargetTypeFilter;
  targetId: string;
  label: string;
  canDeliver: boolean;
}

interface DeliveryTargetCursor {
  offset: number;
  query?: string;
  platform?: DeliveryPlatformFilter;
  targetType?: DeliveryTargetTypeFilter;
  limit?: number;
}

interface SearchDeliveryTargetsParams {
  query?: string;
  platform?: DeliveryPlatformFilter;
  targetType?: DeliveryTargetTypeFilter;
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function normalizeQuery(query: string | undefined): string {
  return query?.trim().replace(/^#/, "").toLowerCase() ?? "";
}

function matchesQuery(value: string, query: string): boolean {
  return !query || value.toLowerCase().includes(query);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function encodeCursor(cursor: DeliveryTargetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): DeliveryTargetCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as DeliveryTargetCursor;
    if (!Number.isInteger(decoded.offset) || decoded.offset < 0) return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function handleSearchDeliveryTargets(
  params: SearchDeliveryTargetsParams,
  deps: Pick<
    SketchMcpDeps,
    | "db"
    | "getSlack"
    | "sendTargetMessage"
    | "getWhatsApp"
    | "currentUserId"
    | "userRepo"
    | "publicMcp"
    | "slackEntitySyncEnabled"
    | "logger"
  >,
): Promise<ToolResult> {
  if (!deps.db) {
    return { content: [{ type: "text", text: "Delivery target search is not available in this context." }] };
  }

  const cursor = decodeCursor(params.cursor);
  if (params.cursor && !cursor) {
    return { content: [{ type: "text", text: JSON.stringify({ matches: [], nextCursor: null }, null, 2) }] };
  }

  const query = normalizeQuery(cursor?.query ?? params.query);
  const platform = cursor?.platform ?? params.platform;
  const targetType = cursor?.targetType ?? params.targetType;
  const limit = normalizeLimit(params.limit ?? cursor?.limit);
  const offset = cursor?.offset ?? 0;
  const pageEnd = offset + limit;
  const matches: DeliveryTargetMatch[] = [];
  const viewerPrincipals = await resolveViewerPrincipals(deps).catch((error) => {
    deps.logger?.warn({ err: error }, "Delivery target principal resolution failed closed");
    return [];
  });

  if ((!platform || platform === "slack") && (!targetType || targetType === "channel")) {
    const slack = deps.getSlack?.() ?? null;
    if (slack) {
      const channels = await slack.listChannels();
      const authorized = await authorizedTargets(
        deps.db,
        viewerPrincipals,
        channels.map((channel) => ({ platform: "slack" as const, targetId: channel.id })),
        deps.logger,
      );
      for (const channel of channels) {
        if (!channel.isMember || !authorized.has(`slack:${channel.id}`) || !matchesQuery(channel.name, query)) continue;
        matches.push({
          platform: "slack",
          targetType: "channel",
          targetId: channel.id,
          label: `#${channel.name}`,
          canDeliver: true,
        });
      }
    }
  }

  if ((!platform || platform === "slack") && (!targetType || targetType === "dm")) {
    const slack = deps.getSlack?.() ?? null;
    if (slack) {
      const rows = await deps.db
        .selectFrom("users")
        .select(["name", "email", "slack_user_id"])
        .where("type", "!=", "agent")
        .where("slack_user_id", "is not", null)
        .where((eb) =>
          eb.or([
            eb(sql`lower(name)`, "like", `%${query}%`),
            eb(sql`lower(coalesce(email, ''))`, "like", `%${query}%`),
            eb(sql`lower(coalesce(slack_user_id, ''))`, "like", `%${query}%`),
          ]),
        )
        .orderBy("name", "asc")
        .execute();

      for (const row of rows) {
        matches.push({
          platform: "slack",
          targetType: "dm",
          targetId: row.slack_user_id as string,
          label: row.email ? `${row.name} <${row.email}>` : row.name,
          canDeliver: true,
        });
      }
    }
  }

  if ((!platform || platform === "whatsapp") && (!targetType || targetType === "group")) {
    const rows = await deps.db
      .selectFrom("whatsapp_groups")
      .select(["jid", "name", "description"])
      .where((eb) =>
        eb.or([
          eb(sql`lower(name)`, "like", `%${query}%`),
          eb(sql`lower(coalesce(description, ''))`, "like", `%${query}%`),
          eb(sql`lower(jid)`, "like", `%${query}%`),
        ]),
      )
      .orderBy("name", "asc")
      .execute();

    const authorized = await authorizedTargets(
      deps.db,
      viewerPrincipals,
      rows.map((row) => ({ platform: "whatsapp" as const, targetId: row.jid })),
      deps.logger,
    );
    for (const row of rows) {
      if (!authorized.has(`whatsapp:${row.jid}`)) continue;
      matches.push({
        platform: "whatsapp",
        targetType: "group",
        targetId: row.jid,
        label: row.name,
        canDeliver: deps.getWhatsApp ? Boolean(deps.getWhatsApp()?.isConnected) : Boolean(deps.sendTargetMessage),
      });
    }
  }

  const pageMatches = matches.slice(offset, pageEnd);
  const nextCursor =
    matches.length > pageEnd
      ? encodeCursor({
          offset: pageEnd,
          query: query || undefined,
          platform,
          targetType,
          limit,
        })
      : null;

  return { content: [{ type: "text", text: JSON.stringify({ matches: pageMatches, nextCursor }, null, 2) }] };
}

export function createSearchDeliveryTargetsTool(deps: SketchMcpDeps) {
  return tool(
    "SearchDeliveryTargets",
    "Search/list deliverable Slack channels, Slack DMs, and WhatsApp groups. Use targetType='dm' to list Slack people.",
    searchDeliveryTargetsSchema,
    async (params) => handleSearchDeliveryTargets(params, deps),
  );
}
