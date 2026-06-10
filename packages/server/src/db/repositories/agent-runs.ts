import { randomUUID } from "node:crypto";
import { type Insertable, type Kysely, sql } from "kysely";
import { isPg } from "../dialect";
import type { DB } from "../schema";

type NewAgentRun = Insertable<DB["agent_runs"]>;
type NewToolCall = Insertable<DB["tool_calls"]>;

export interface MemberSummary {
  totalMessages: number;
  messagesByPlatform: { platform: string; count: number }[];
  totalCostUsd: number;
  totalSkills: number;
}

export interface SkillBreakdown {
  name: string;
  count: number;
}

export interface OrgSummary {
  totalMessages: number;
  messagesByPlatform: { platform: string; count: number }[];
  totalCostUsd: number;
  totalSkills: number;
}

export interface UserBreakdown {
  userId: string;
  userName: string | null;
  userType: string;
  messageCount: number;
  costUsd: number;
  skillCount: number;
  lastRunAt: string | null;
}

export interface GroupBreakdown {
  workspaceKey: string;
  name: string;
  platform: "slack" | "whatsapp";
  messageCount: number;
  skillCount: number;
  lastRunAt: string | null;
}

export interface DailyBucket {
  date: string;
  messages: number;
  skills: number;
}

/**
 * Total spend = agent-model cost (`cost_usd`) + auxiliary LLM cost
 * (`aux_cost_usd`, transcription/vision). Both are indexed columns, so the sum
 * stays a plain SQL aggregation (no JSON extraction). `prefix` is "" for an
 * unaliased table or "r." when joined as `agent_runs as r`.
 *
 * The Postgres branch wraps the whole sum in parentheses before `::numeric`
 * because the cast binds tighter than `+`; without them only the second term
 * casts and `ROUND(double precision, integer)` (which Postgres lacks) is called.
 */
function roundedCostSum(db: Kysely<DB>, prefix: "" | "r.") {
  const sum = sql`COALESCE(SUM(${sql.ref(`${prefix}cost_usd`)}), 0) + COALESCE(SUM(${sql.ref(`${prefix}aux_cost_usd`)}), 0)`;
  return isPg(db) ? sql<number>`ROUND((${sum})::numeric, 6)` : sql<number>`ROUND(${sum}, 6)`;
}

/**
 * Agent runs repository — write path (insertRun, insertToolCalls) and read path (usage queries).
 *
 * Usage query design:
 * - agent_runs and tool_calls are never joined in the same GROUP BY aggregation to prevent
 *   fan-out (a run with N tool calls would multiply COUNT/SUM by N). Skill counts are always
 *   fetched in a separate query and merged via Map in application code.
 * - Per-user queries exclude `context_type = 'channel_mention'` runs. Those are counted
 *   separately in getGroupBreakdown. Org-level totals (getOrgSummary) count all runs,
 *   so `by_user_sum + by_group_sum = total`.
 */
export function createAgentRunsRepo(db: Kysely<DB>) {
  return {
    async insertRun(run: Omit<NewAgentRun, "id"> & { id?: string }): Promise<string> {
      const id = run.id ?? randomUUID();
      const created_at = run.created_at ?? new Date().toISOString();
      await db
        .insertInto("agent_runs")
        .values({ ...run, id, created_at })
        .execute();
      return id;
    },

    async insertToolCalls(calls: NewToolCall[]): Promise<void> {
      if (calls.length === 0) return;
      await db.insertInto("tool_calls").values(calls).execute();
    },

    /** Messages, cost, and skill totals for a single user in a date range. */
    async getMemberSummary(userId: string, from: string, to: string): Promise<MemberSummary> {
      const byPlatform = await db
        .selectFrom("agent_runs")
        .select(["platform", sql<number>`COUNT(id)`.as("count"), roundedCostSum(db, "").as("cost")])
        .where("user_id", "=", userId)
        .where("created_at", ">=", from)
        .where("created_at", "<", to)
        .where("context_type", "!=", "channel_mention")
        .groupBy("platform")
        .execute();

      const skillTotal = await db
        .selectFrom("tool_calls as tc")
        .innerJoin("agent_runs as r", "r.id", "tc.agent_run_id")
        .select(sql<number>`COUNT(tc.id)`.as("count"))
        .where("r.user_id", "=", userId)
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("r.context_type", "!=", "channel_mention")
        .where("tc.skill_name", "is not", null)
        .executeTakeFirstOrThrow();

      let totalMessages = 0;
      let totalCostUsd = 0;
      for (const r of byPlatform) {
        totalMessages += Number(r.count);
        totalCostUsd += Number(r.cost);
      }

      return {
        totalMessages,
        messagesByPlatform: byPlatform.map((r) => ({ platform: r.platform, count: Number(r.count) })),
        totalCostUsd,
        totalSkills: Number(skillTotal.count) || 0,
      };
    },

    /** Per-skill breakdown for a single user. */
    async getMemberSkills(userId: string, from: string, to: string): Promise<SkillBreakdown[]> {
      const rows = await db
        .selectFrom("tool_calls as tc")
        .innerJoin("agent_runs as r", "r.id", "tc.agent_run_id")
        .select(["tc.skill_name", sql<number>`COUNT(tc.id)`.as("count")])
        .where("r.user_id", "=", userId)
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("r.context_type", "!=", "channel_mention")
        .where("tc.skill_name", "is not", null)
        .groupBy("tc.skill_name")
        .orderBy("count", "desc")
        .execute();

      return rows.map((r) => ({ name: r.skill_name as string, count: Number(r.count) }));
    },

    /** Org-wide totals including all context types (channel_mention + DM). */
    async getOrgSummary(from: string, to: string): Promise<OrgSummary> {
      const byPlatform = await db
        .selectFrom("agent_runs")
        .select(["platform", sql<number>`COUNT(id)`.as("count"), roundedCostSum(db, "").as("cost")])
        .where("created_at", ">=", from)
        .where("created_at", "<", to)
        .groupBy("platform")
        .execute();

      const skillTotal = await db
        .selectFrom("tool_calls as tc")
        .innerJoin("agent_runs as r", "r.id", "tc.agent_run_id")
        .select(sql<number>`COUNT(tc.id)`.as("count"))
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("tc.skill_name", "is not", null)
        .executeTakeFirstOrThrow();

      let totalMessages = 0;
      let totalCostUsd = 0;
      for (const r of byPlatform) {
        totalMessages += Number(r.count);
        totalCostUsd += Number(r.cost);
      }

      return {
        totalMessages,
        messagesByPlatform: byPlatform.map((r) => ({ platform: r.platform, count: Number(r.count) })),
        totalCostUsd,
        totalSkills: Number(skillTotal.count) || 0,
      };
    },

    /** Per-skill breakdown across entire org. */
    async getOrgSkills(from: string, to: string): Promise<SkillBreakdown[]> {
      const rows = await db
        .selectFrom("tool_calls as tc")
        .innerJoin("agent_runs as r", "r.id", "tc.agent_run_id")
        .select(["tc.skill_name", sql<number>`COUNT(tc.id)`.as("count")])
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("tc.skill_name", "is not", null)
        .groupBy("tc.skill_name")
        .orderBy("count", "desc")
        .execute();

      return rows.map((r) => ({ name: r.skill_name as string, count: Number(r.count) }));
    },

    /** Per-user breakdown with skill counts merged from a separate query. */
    async getOrgByUser(from: string, to: string): Promise<UserBreakdown[]> {
      const userRows = await db
        .selectFrom("agent_runs as r")
        .leftJoin("users as u", "u.id", "r.user_id")
        .select([
          "r.user_id as userId",
          "u.name as userName",
          "u.type as userType",
          sql<number>`COUNT(r.id)`.as("messageCount"),
          roundedCostSum(db, "r.").as("costUsd"),
          sql<string>`MAX(r.created_at)`.as("lastRunAt"),
        ])
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("r.context_type", "!=", "channel_mention")
        .groupBy(["r.user_id", "u.name", "u.type"])
        .orderBy("costUsd", "desc")
        .execute();

      const skillRows = await db
        .selectFrom("tool_calls as tc")
        .innerJoin("agent_runs as r", "r.id", "tc.agent_run_id")
        .select(["r.user_id", sql<number>`COUNT(tc.id)`.as("skillCount")])
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("r.context_type", "!=", "channel_mention")
        .where("tc.skill_name", "is not", null)
        .groupBy("r.user_id")
        .execute();

      const skillMap = new Map(skillRows.map((r) => [r.user_id, Number(r.skillCount)]));

      return userRows.map((r) => ({
        userId: r.userId ?? "unattributed",
        userName: r.userName ?? null,
        userType: r.userType ?? "human",
        messageCount: Number(r.messageCount),
        costUsd: Number(r.costUsd),
        skillCount: skillMap.get(r.userId) ?? 0,
        lastRunAt: r.lastRunAt ?? null,
      }));
    },

    /**
     * Aggregates channel_mention runs by workspace key (Slack channel / WhatsApp group).
     * Resolves display names from channels and whatsapp_groups tables.
     */
    async getGroupBreakdown(from: string, to: string): Promise<GroupBreakdown[]> {
      const wsKey = isPg(db)
        ? sql<string>`(r.attributes::jsonb ->> 'sketch.workspace_key')`
        : sql<string>`json_extract(r.attributes, '$."sketch.workspace_key"')`;

      const msgRows = await db
        .selectFrom("agent_runs as r")
        .select([
          wsKey.as("workspaceKey"),
          "r.platform",
          sql<number>`COUNT(r.id)`.as("messageCount"),
          sql<string>`MAX(r.created_at)`.as("lastRunAt"),
        ])
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("r.context_type", "=", "channel_mention")
        .where(wsKey, "is not", null)
        .groupBy([wsKey, "r.platform"])
        .orderBy("messageCount", "desc")
        .execute();

      if (msgRows.length === 0) return [];

      const skillRows = await db
        .selectFrom("tool_calls as tc")
        .innerJoin("agent_runs as r", "r.id", "tc.agent_run_id")
        .select([wsKey.as("workspaceKey"), sql<number>`COUNT(tc.id)`.as("skillCount")])
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("r.context_type", "=", "channel_mention")
        .where("tc.skill_name", "is not", null)
        .groupBy(wsKey)
        .execute();

      const skillMap = new Map(skillRows.map((r) => [r.workspaceKey, Number(r.skillCount)]));

      const slackIds: string[] = [];
      const waJids: string[] = [];
      for (const row of msgRows) {
        const wk = row.workspaceKey;
        if (wk?.startsWith("channel-")) slackIds.push(wk.slice(8));
        else if (wk?.startsWith("wa-group-")) waJids.push(wk.slice(9));
      }

      const channelNames = new Map<string, string>();
      if (slackIds.length > 0) {
        const rows = await db
          .selectFrom("channels")
          .select(["slack_channel_id", "name"])
          .where("slack_channel_id", "in", slackIds)
          .execute();
        for (const r of rows) channelNames.set(r.slack_channel_id, r.name);
      }

      const groupNames = new Map<string, string>();
      if (waJids.length > 0) {
        const rows = await db
          .selectFrom("whatsapp_groups")
          .select(["jid", "name"])
          .where("jid", "in", waJids)
          .execute();
        for (const r of rows) groupNames.set(r.jid, r.name);
      }

      return msgRows.map((r) => {
        const wk = r.workspaceKey ?? "";
        let name = wk;
        let platform: "slack" | "whatsapp" = r.platform as "slack" | "whatsapp";
        if (wk.startsWith("channel-")) {
          const slackId = wk.slice(8);
          name = channelNames.get(slackId) ?? `#${slackId}`;
          platform = "slack";
        } else if (wk.startsWith("wa-group-")) {
          const jid = wk.slice(9);
          name = groupNames.get(jid) ?? jid;
          platform = "whatsapp";
        }
        return {
          workspaceKey: wk,
          name,
          platform,
          messageCount: Number(r.messageCount),
          skillCount: skillMap.get(wk) ?? 0,
          lastRunAt: r.lastRunAt ?? null,
        };
      });
    },

    /** Sparse per-day message and skill counts. When userId is provided, excludes channel_mention. */
    async getDailyBreakdown(userId: string | null, from: string, to: string): Promise<DailyBucket[]> {
      let msgQuery = db
        .selectFrom("agent_runs")
        .select([sql<string>`DATE(created_at)`.as("date"), sql<number>`COUNT(id)`.as("messages")])
        .where("created_at", ">=", from)
        .where("created_at", "<", to)
        .groupBy(sql`DATE(created_at)`)
        .orderBy(sql`DATE(created_at)`);
      if (userId !== null) {
        msgQuery = msgQuery.where("user_id", "=", userId).where("context_type", "!=", "channel_mention");
      }
      const msgRows = await msgQuery.execute();

      let skillQuery = db
        .selectFrom("tool_calls as tc")
        .innerJoin("agent_runs as r", "r.id", "tc.agent_run_id")
        .select([sql<string>`DATE(r.created_at)`.as("date"), sql<number>`COUNT(tc.id)`.as("skills")])
        .where("r.created_at", ">=", from)
        .where("r.created_at", "<", to)
        .where("tc.skill_name", "is not", null)
        .groupBy(sql`DATE(r.created_at)`)
        .orderBy(sql`DATE(r.created_at)`);
      if (userId !== null) {
        skillQuery = skillQuery.where("r.user_id", "=", userId).where("r.context_type", "!=", "channel_mention");
      }
      const skillRows = await skillQuery.execute();

      const skillMap = new Map(skillRows.map((r) => [r.date, Number(r.skills)]));

      return msgRows.map((r) => ({
        date: r.date,
        messages: Number(r.messages),
        skills: skillMap.get(r.date) ?? 0,
      }));
    },
  };
}
