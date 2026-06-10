import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createAgentRunsRepo } from "../db/repositories/agent-runs";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger, getSharedPgDb } from "../test-utils";

const config = createTestConfig();
const logger = createTestLogger();

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();
  await settings.create();
  await users.create({
    name: normalizedEmail.split("@")[0],
    email: normalizedEmail,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function loginAdmin(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function getMemberCookie(db: Kysely<DB>, userId: string): Promise<string> {
  const settings = createSettingsRepository(db);
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found in test DB");
  const token = await signJwt(userId, "member", row.jwt_secret);
  return `sketch_session=${token}`;
}

/** Seed agent runs and tool calls for a given user within a date range. */
async function seedUsageData(db: Kysely<DB>, userId: string) {
  const repo = createAgentRunsRepo(db);

  // Run 1: slack, cost 1.50, March 2026
  const run1 = await repo.insertRun({
    trace_id: "trace-1",
    user_id: userId,
    platform: "slack",
    context_type: "dm",
    cost_usd: 1.5,
    created_at: "2026-03-10T10:00:00.000Z",
  });
  await repo.insertToolCalls([
    { agent_run_id: run1, tool_name: "canvas:search-apps", skill_name: "canvas" },
    { agent_run_id: run1, tool_name: "Bash", skill_name: null },
  ]);

  // Run 2: whatsapp, cost 0.75, March 2026
  const run2 = await repo.insertRun({
    trace_id: "trace-2",
    user_id: userId,
    platform: "whatsapp",
    context_type: "dm",
    cost_usd: 0.75,
    created_at: "2026-03-15T14:00:00.000Z",
  });
  await repo.insertToolCalls([
    { agent_run_id: run2, tool_name: "canvas:execute-action", skill_name: "canvas" },
    { agent_run_id: run2, tool_name: "send-email", skill_name: "send-email" },
  ]);

  // Run 3: slack, cost 0.25, March 2026
  const run3 = await repo.insertRun({
    trace_id: "trace-3",
    user_id: userId,
    platform: "slack",
    context_type: "channel",
    cost_usd: 0.25,
    created_at: "2026-03-20T08:00:00.000Z",
  });
  await repo.insertToolCalls([{ agent_run_id: run3, tool_name: "Read", skill_name: null }]);

  return { run1, run2, run3 };
}

/** Seed an agent run in a different month (February) to test period filtering. */
async function seedOutOfRangeRun(db: Kysely<DB>, userId: string) {
  const repo = createAgentRunsRepo(db);
  await repo.insertRun({
    trace_id: "trace-old",
    user_id: userId,
    platform: "slack",
    context_type: "dm",
    cost_usd: 5.0,
    created_at: "2026-02-15T10:00:00.000Z",
  });
}

describe("Usage API", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  // --- GET /api/usage/me ---

  describe("GET /api/usage/me", () => {
    it("returns member usage with correct totals for monthly period", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "Alice", email: "alice@test.com" });
      await seedUsageData(db, member.id);

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Period
      expect(body.period.type).toBe("monthly");
      expect(body.period.from).toBe("2026-03-01T00:00:00.000Z");
      expect(body.period.to).toBe("2026-04-01T00:00:00.000Z");

      // Messages
      expect(body.messages.total).toBe(3);
      const platforms = body.messages.by_platform.map((p: { platform: string }) => p.platform).sort();
      expect(platforms).toEqual(["slack", "whatsapp"]);

      const slackCount = body.messages.by_platform.find((p: { platform: string }) => p.platform === "slack")?.count;
      const whatsappCount = body.messages.by_platform.find(
        (p: { platform: string }) => p.platform === "whatsapp",
      )?.count;
      expect(slackCount).toBe(2);
      expect(whatsappCount).toBe(1);

      // by_platform sums to total (UAT-8)
      const platformSum = body.messages.by_platform.reduce((sum: number, p: { count: number }) => sum + p.count, 0);
      expect(platformSum).toBe(body.messages.total);

      // Spend
      expect(body.spend.total_cost_usd).toBe(2.5);

      // Skills (canvas x2, send-email x1 = 3 total)
      expect(body.skills.total).toBe(3);
      expect(body.skills.by_skill).toContainEqual({ name: "canvas", count: 2 });
      expect(body.skills.by_skill).toContainEqual({ name: "send-email", count: 1 });
    });

    it("spend total includes aux_cost_usd alongside agent cost_usd", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "AuxMe", email: "aux-me@test.com" });
      const repo = createAgentRunsRepo(db);

      await repo.insertRun({
        trace_id: "aux-me-1",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 1.0,
        aux_cost_usd: 0.05,
        created_at: "2026-03-10T10:00:00.000Z",
      });
      await repo.insertRun({
        trace_id: "aux-me-2",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 0.5,
        aux_cost_usd: 0,
        created_at: "2026-03-11T10:00:00.000Z",
      });

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spend.total_cost_usd).toBe(1.55);
    });

    it("includes daily_breakdown with per-day message and skill counts", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "ChartUser", email: "chart@test.com" });
      await seedUsageData(db, member.id);

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Should have daily_breakdown array
      expect(body.daily_breakdown).toBeDefined();
      expect(Array.isArray(body.daily_breakdown)).toBe(true);

      // Seed data has runs on 2026-03-10, 2026-03-15, 2026-03-20
      expect(body.daily_breakdown.length).toBe(3);

      const mar10 = body.daily_breakdown.find((d: { date: string }) => d.date === "2026-03-10");
      expect(mar10).toBeDefined();
      expect(mar10.messages).toBe(1);
      expect(mar10.skills).toBe(1); // one canvas skill call

      const mar15 = body.daily_breakdown.find((d: { date: string }) => d.date === "2026-03-15");
      expect(mar15).toBeDefined();
      expect(mar15.messages).toBe(1);
      expect(mar15.skills).toBe(2); // canvas + send-email

      const mar20 = body.daily_breakdown.find((d: { date: string }) => d.date === "2026-03-20");
      expect(mar20).toBeDefined();
      expect(mar20.messages).toBe(1);
      expect(mar20.skills).toBe(0); // no skill calls

      // Sum of daily messages should equal total
      const dailyMsgSum = body.daily_breakdown.reduce((sum: number, d: { messages: number }) => sum + d.messages, 0);
      expect(dailyMsgSum).toBe(body.messages.total);
    });

    it("daily_breakdown is empty for period with no data", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "EmptyChart", email: "empty-chart@test.com" });

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2020-01-01", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.daily_breakdown).toEqual([]);
    });

    it("defaults to monthly when no period param is given (UAT-2)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "Bob", email: "bob@test.com" });

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.type).toBe("monthly");
    });

    it("returns weekly period with Monday start (UAT-5)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "Carol", email: "carol@test.com" });

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      // 2026-03-26 is a Thursday
      const res = await app.request("/api/usage/me?period=weekly&date=2026-03-26", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.type).toBe("weekly");
      // Monday of that week is March 23
      expect(body.period.from).toBe("2026-03-23T00:00:00.000Z");
      expect(body.period.to).toBe("2026-03-30T00:00:00.000Z");
    });

    it("returns quarterly period boundaries (UAT-6)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "Dave", email: "dave@test.com" });

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=quarterly&date=2026-05-15", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.from).toBe("2026-04-01T00:00:00.000Z");
      expect(body.period.to).toBe("2026-07-01T00:00:00.000Z");
    });

    it("returns zeros and empty arrays for a period with no data (UAT-13)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "Eve", email: "eve@test.com" });

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2020-01-01", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages.total).toBe(0);
      expect(body.messages.by_platform).toEqual([]);
      expect(body.spend.total_cost_usd).toBe(0);
      expect(body.skills.total).toBe(0);
      expect(body.skills.by_skill).toEqual([]);
    });

    it("weekly period includes data on period start date", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "WeekBug", email: "weekbug@test.com" });
      const repo = createAgentRunsRepo(db);

      await repo.insertRun({
        trace_id: "trace-week-1",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 1.0,
        created_at: "2026-03-30T10:15:23.000Z",
      });
      await repo.insertRun({
        trace_id: "trace-week-2",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 0.52,
        created_at: "2026-03-30T14:30:00.000Z",
      });

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      // 2026-03-30 is a Monday — weekly period should be [Mar 30, Apr 6)
      const res = await app.request("/api/usage/me?period=weekly&date=2026-03-30", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.from).toBe("2026-03-30T00:00:00.000Z");
      expect(body.period.to).toBe("2026-04-06T00:00:00.000Z");
      expect(body.messages.total).toBe(2);
      expect(body.spend.total_cost_usd).toBe(1.52);
      expect(body.daily_breakdown).toHaveLength(1);
      expect(body.daily_breakdown[0].date).toBe("2026-03-30");
    });

    it("excludes out-of-range data (UAT-12 — weekly <= monthly)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "Frank", email: "frank@test.com" });
      await seedUsageData(db, member.id);
      await seedOutOfRangeRun(db, member.id);

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      // Monthly March should have 3 runs
      const monthlyRes = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
        headers: { Cookie: cookie },
      });
      const monthly = await monthlyRes.json();
      expect(monthly.messages.total).toBe(3);

      // February monthly should have the 1 out-of-range run
      const febRes = await app.request("/api/usage/me?period=monthly&date=2026-02-15", {
        headers: { Cookie: cookie },
      });
      const feb = await febRes.json();
      expect(feb.messages.total).toBe(1);
      expect(feb.spend.total_cost_usd).toBe(5.0);
    });

    it("does not show other users' data", async () => {
      const users = createUserRepository(db);
      const alice = await users.create({ name: "Alice", email: "alice2@test.com" });
      const bob = await users.create({ name: "Bob", email: "bob2@test.com" });

      await seedUsageData(db, alice.id);

      const app = createApp(db, config, { logger });
      const bobCookie = await getMemberCookie(db, bob.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
        headers: { Cookie: bobCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages.total).toBe(0);
    });
  });

  // --- GET /api/usage/summary ---

  describe("GET /api/usage/summary", () => {
    it("returns org-wide summary for admin (UAT-3)", async () => {
      const users = createUserRepository(db);
      const alice = await users.create({ name: "Alice", email: "alice3@test.com" });
      const bob = await users.create({ name: "Bot", email: "bot@test.com", type: "agent" });
      await seedUsageData(db, alice.id);

      // Add a run for the agent user
      const repo = createAgentRunsRepo(db);
      await repo.insertRun({
        trace_id: "trace-bot",
        user_id: bob.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 0.3,
        created_at: "2026-03-12T10:00:00.000Z",
      });

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Total messages = Alice's 3 + Bot's 1 = 4
      expect(body.messages.total).toBe(4);

      // Has by_user breakdown
      expect(body.by_user).toBeDefined();
      expect(body.by_user.length).toBe(2);

      // by_user + by_group sums match totals (UAT-9)
      // by_user excludes channel_mention, by_group only includes channel_mention
      const userMsgSum = body.by_user.reduce((s: number, u: { messageCount: number }) => s + u.messageCount, 0);
      const groupMsgSum = (body.by_group ?? []).reduce(
        (s: number, g: { messageCount: number }) => s + g.messageCount,
        0,
      );
      expect(userMsgSum + groupMsgSum).toBe(body.messages.total);

      const costSum = body.by_user.reduce((s: number, u: { costUsd: number }) => s + u.costUsd, 0);
      // costSum may be less than total if channel_mention runs have cost — that's correct

      // Agent user appears with correct type (UAT-10)
      const agentUser = body.by_user.find((u: { userType: string }) => u.userType === "agent");
      expect(agentUser).toBeDefined();
      expect(agentUser.messageCount).toBe(1);
    });

    it("by_user cost and org spend include aux_cost_usd", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "AuxUser", email: "aux-user@test.com" });
      const repo = createAgentRunsRepo(db);

      await repo.insertRun({
        trace_id: "aux-summary-1",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 2.0,
        aux_cost_usd: 0.1,
        created_at: "2026-03-10T10:00:00.000Z",
      });

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spend.total_cost_usd).toBe(2.1);
      const user = body.by_user.find((u: { userId: string }) => u.userId === member.id);
      expect(user).toBeDefined();
      expect(user.costUsd).toBe(2.1);
    });

    it("returns zeros for empty period", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=monthly&date=2020-01-01", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages.total).toBe(0);
      expect(body.by_user).toEqual([]);
      expect(body.skills.total).toBe(0);
    });

    it("handles null user_id runs as unattributed (EC-10)", async () => {
      const repo = createAgentRunsRepo(db);
      await repo.insertRun({
        trace_id: "trace-null",
        user_id: null,
        platform: "slack",
        context_type: "dm",
        cost_usd: 0.1,
        created_at: "2026-03-10T10:00:00.000Z",
      });

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messages.total).toBe(1);

      const unattributed = body.by_user.find((u: { userId: string }) => u.userId === "unattributed");
      expect(unattributed).toBeDefined();
      expect(unattributed.userName).toBeNull();
    });

    it("skills tracked correctly after skill tool calls (UAT-11)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "SkillUser", email: "skill@test.com" });
      await seedUsageData(db, member.id);

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skills.total).toBeGreaterThanOrEqual(1);
      const skillNames = body.skills.by_skill.map((s: { name: string }) => s.name);
      expect(skillNames).toContain("canvas");
    });
  });

  // --- Input Validation ---

  describe("Input validation", () => {
    it("returns 400 for invalid period param (UAT-14)", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/me?period=daily", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("daily");
    });

    it("returns 400 for invalid date param (UAT-15)", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/me?date=not-a-date", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("not-a-date");
    });

    it("accepts valid weekly+date combination (UAT-16)", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/me?period=weekly&date=2026-03-26", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.type).toBe("weekly");
    });

    it("returns 400 for invalid period on /summary", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=hourly", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(400);
    });
  });

  // --- Data Integrity ---

  describe("Data integrity", () => {
    it("no fan-out: cost is not inflated by tool call count (EC-1)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "FanOut", email: "fanout@test.com" });

      const repo = createAgentRunsRepo(db);
      // 1 run with cost 2.00, 5 tool calls
      const runId = await repo.insertRun({
        trace_id: "trace-fanout",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 2.0,
        created_at: "2026-03-10T10:00:00.000Z",
      });
      await repo.insertToolCalls([
        { agent_run_id: runId, tool_name: "tool1", skill_name: "skill-a" },
        { agent_run_id: runId, tool_name: "tool2", skill_name: "skill-a" },
        { agent_run_id: runId, tool_name: "tool3", skill_name: "skill-b" },
        { agent_run_id: runId, tool_name: "tool4", skill_name: null },
        { agent_run_id: runId, tool_name: "tool5", skill_name: null },
      ]);

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
        headers: { Cookie: cookie },
      });

      const body = await res.json();
      // Must be exactly 1 message, not 5
      expect(body.messages.total).toBe(1);
      // Must be exactly $2.00, not $10.00
      expect(body.spend.total_cost_usd).toBe(2.0);
      // Skills: skill-a x2, skill-b x1 = 3
      expect(body.skills.total).toBe(3);
    });

    it("admin summary by_user cost not inflated by tool calls (EC-1)", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "FanOut2", email: "fanout2@test.com" });

      const repo = createAgentRunsRepo(db);
      const runId = await repo.insertRun({
        trace_id: "trace-fanout2",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 3.0,
        created_at: "2026-03-10T10:00:00.000Z",
      });
      await repo.insertToolCalls([
        { agent_run_id: runId, tool_name: "t1", skill_name: "s1" },
        { agent_run_id: runId, tool_name: "t2", skill_name: "s1" },
        { agent_run_id: runId, tool_name: "t3", skill_name: "s2" },
      ]);

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
        headers: { Cookie: adminCookie },
      });

      const body = await res.json();
      const user = body.by_user.find((u: { userId: string }) => u.userId === member.id);
      expect(user).toBeDefined();
      expect(user.messageCount).toBe(1);
      expect(user.costUsd).toBe(3.0);
      expect(user.skillCount).toBe(3);
    });

    it("monthly period Feb boundary is correct (UAT-7)", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/me?period=monthly&date=2026-02-15", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.from).toBe("2026-02-01T00:00:00.000Z");
      expect(body.period.to).toBe("2026-03-01T00:00:00.000Z");
    });
  });

  // --- Double-counting prevention (channel_mention exclusion) ---

  describe("Double-counting prevention", () => {
    it("/me excludes channel_mention runs from totals", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "DblCount", email: "dblcount@test.com" });
      const repo = createAgentRunsRepo(db);

      // 2 DM runs
      await repo.insertRun({
        trace_id: "dc-dm-1",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 1.0,
        created_at: "2026-03-10T10:00:00.000Z",
      });
      await repo.insertRun({
        trace_id: "dc-dm-2",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 0.5,
        created_at: "2026-03-11T10:00:00.000Z",
      });

      // 1 channel_mention run (should be excluded from /me)
      const channelRunId = await repo.insertRun({
        trace_id: "dc-channel-1",
        user_id: member.id,
        platform: "slack",
        context_type: "channel_mention",
        cost_usd: 0.3,
        created_at: "2026-03-12T10:00:00.000Z",
      });
      await repo.insertToolCalls([{ agent_run_id: channelRunId, tool_name: "canvas:search", skill_name: "canvas" }]);

      const app = createApp(db, config, { logger });
      const cookie = await getMemberCookie(db, member.id);

      const res = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Only DM runs counted: 2 messages, $1.50
      expect(body.messages.total).toBe(2);
      expect(body.spend.total_cost_usd).toBe(1.5);

      // Channel skill not counted
      expect(body.skills.total).toBe(0);

      // Daily breakdown excludes channel run
      expect(body.daily_breakdown.length).toBe(2);
    });

    it("/summary by_user excludes channel_mention, by_group includes it", async () => {
      const users = createUserRepository(db);
      const member = await users.create({ name: "DblAdmin", email: "dbladmin@test.com" });
      const repo = createAgentRunsRepo(db);

      // 1 DM run
      await repo.insertRun({
        trace_id: "da-dm-1",
        user_id: member.id,
        platform: "slack",
        context_type: "dm",
        cost_usd: 1.0,
        created_at: "2026-03-10T10:00:00.000Z",
      });

      // 1 channel_mention run with workspace_key
      const channelRunId = await repo.insertRun({
        trace_id: "da-channel-1",
        user_id: member.id,
        platform: "slack",
        context_type: "channel_mention",
        cost_usd: 0.2,
        created_at: "2026-03-11T10:00:00.000Z",
        attributes: JSON.stringify({ "sketch.workspace_key": "channel-C999TEST" }),
      });
      await repo.insertToolCalls([{ agent_run_id: channelRunId, tool_name: "Read", skill_name: null }]);

      // Seed the channel name
      await db
        .insertInto("channels")
        .values({ id: "ch-test", slack_channel_id: "C999TEST", name: "test-channel", type: "public_channel" })
        .execute();

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Org total includes everything: 2 messages
      expect(body.messages.total).toBe(2);

      // by_user: only DM run (1 message)
      const user = body.by_user.find((u: { userId: string }) => u.userId === member.id);
      expect(user).toBeDefined();
      expect(user.messageCount).toBe(1);

      // by_group: only channel_mention run (1 message)
      expect(body.by_group).toBeDefined();
      expect(body.by_group.length).toBe(1);
      expect(body.by_group[0].name).toBe("test-channel");
      expect(body.by_group[0].messageCount).toBe(1);

      // by_user_sum + by_group_sum = total
      const userSum = body.by_user.reduce((s: number, u: { messageCount: number }) => s + u.messageCount, 0);
      const groupSum = body.by_group.reduce((s: number, g: { messageCount: number }) => s + g.messageCount, 0);
      expect(userSum + groupSum).toBe(body.messages.total);
    });
  });

  // --- Auth ---

  describe("Auth", () => {
    it("returns 401 without authentication", async () => {
      const app = createApp(db, config, { logger });

      const meRes = await app.request("/api/usage/me");
      expect(meRes.status).toBe(401);

      const summaryRes = await app.request("/api/usage/summary");
      expect(summaryRes.status).toBe(401);
    });
  });
});

describe("Usage API on Postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await seedAdmin(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("returns member and org usage without Postgres real rounding errors", async () => {
    const users = createUserRepository(db);
    const member = await users.create({ name: "PgUsage", email: "pg-usage@test.com" });
    const repo = createAgentRunsRepo(db);

    await repo.insertRun({
      trace_id: "pg-usage-1",
      user_id: member.id,
      platform: "slack",
      context_type: "dm",
      cost_usd: 1.11,
      created_at: "2026-03-10T10:00:00.000Z",
    });
    await repo.insertRun({
      trace_id: "pg-usage-2",
      user_id: member.id,
      platform: "whatsapp",
      context_type: "dm",
      cost_usd: 0.22,
      created_at: "2026-03-11T10:00:00.000Z",
    });

    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger });
    const memberCookie = await getMemberCookie(db, member.id);
    const adminCookie = await loginAdmin(app);

    const memberRes = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
      headers: { Cookie: memberCookie },
    });
    expect(memberRes.status).toBe(200);
    const memberBody = await memberRes.json();
    expect(memberBody.messages.total).toBe(2);
    expect(memberBody.spend.total_cost_usd).toBe(1.33);

    const summaryRes = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
      headers: { Cookie: adminCookie },
    });
    expect(summaryRes.status).toBe(200);
    const summaryBody = await summaryRes.json();
    expect(summaryBody.messages.total).toBe(2);
    expect(summaryBody.spend.total_cost_usd).toBe(1.33);
    expect(summaryBody.by_user[0].costUsd).toBe(1.33);
  });

  it("sums aux_cost_usd into member and org spend on Postgres", async () => {
    const users = createUserRepository(db);
    const member = await users.create({ name: "PgAux", email: "pg-aux@test.com" });
    const repo = createAgentRunsRepo(db);

    await repo.insertRun({
      trace_id: "pg-aux-1",
      user_id: member.id,
      platform: "slack",
      context_type: "dm",
      cost_usd: 1.11,
      aux_cost_usd: 0.04,
      created_at: "2026-03-10T10:00:00.000Z",
    });
    await repo.insertRun({
      trace_id: "pg-aux-2",
      user_id: member.id,
      platform: "whatsapp",
      context_type: "dm",
      cost_usd: 0.22,
      aux_cost_usd: 0.03,
      created_at: "2026-03-11T10:00:00.000Z",
    });

    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger });
    const memberCookie = await getMemberCookie(db, member.id);
    const adminCookie = await loginAdmin(app);

    const memberRes = await app.request("/api/usage/me?period=monthly&date=2026-03-15", {
      headers: { Cookie: memberCookie },
    });
    expect(memberRes.status).toBe(200);
    const memberBody = await memberRes.json();
    expect(memberBody.spend.total_cost_usd).toBe(1.4);

    const summaryRes = await app.request("/api/usage/summary?period=monthly&date=2026-03-15", {
      headers: { Cookie: adminCookie },
    });
    expect(summaryRes.status).toBe(200);
    const summaryBody = await summaryRes.json();
    expect(summaryBody.spend.total_cost_usd).toBe(1.4);
    expect(summaryBody.by_user[0].costUsd).toBe(1.4);
  });
});
