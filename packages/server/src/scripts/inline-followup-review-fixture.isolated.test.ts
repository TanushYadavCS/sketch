import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyBriefRoutes, followupReviewRoutes } from "../agents/routes";
import { AgentRunService, type AgentRunServiceDeps } from "../agents/service";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import {
  clearInlineFollowupReviewFixture,
  isolateFollowupReviewQaDatabase,
  seedInlineFollowupReviewFixture,
} from "./inline-followup-review-fixture";

const USER_ID = "inline-followup-review-fixture-user";
const OUTPUT_DATE = "2026-07-20";
const NOW = "2026-07-20T10:00:00.000Z";

describe("inline follow-up review fixture", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db = await createTestDb();
    await db
      .insertInto("users")
      .values({
        id: USER_ID,
        name: "Fixture Reviewer",
        email: "fixture-reviewer@example.com",
        auth_role: "admin",
        timezone: "UTC",
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    vi.useRealTimers();
  });

  it("seeds a brief that can complete and track follow-ups through the public review routes", async () => {
    const fixture = await seedInlineFollowupReviewFixture(db, { userId: USER_ID, now: NOW });
    const app = createFixtureApp(db);

    expect(fixture.commands).toEqual({
      confirmDone: `Confirm done ${fixture.reviewCodes.confirmDone}`,
      keepOpen: `Keep open ${fixture.reviewCodes.keepOpen}`,
      expired: `Confirm done ${fixture.reviewCodes.expired}`,
      track: `Track ${fixture.reviewCodes.track}`,
      dismiss: `Dismiss ${fixture.reviewCodes.dismiss}`,
      missing: "Dismiss QANOTFOUND",
    });

    const latest = await app.request(`/api/daily-briefs?date=${OUTPUT_DATE}`);
    expect(latest.status).toBe(200);
    const body = (await latest.json()) as {
      brief: {
        sections: Record<
          string,
          Array<{
            title: string;
            review: { id: string; kind: string; state: string; canReview: boolean } | null;
          }>
        >;
      };
    };
    expect(body.brief.sections.looks_resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "QA: Confirm completed launch checklist",
          review: expect.objectContaining({
            id: fixture.completionRecommendationIds.confirmDone,
            kind: "completion",
            state: "pending",
            canReview: true,
          }),
        }),
        expect.objectContaining({
          title: "QA: Review an expired completion suggestion",
          review: expect.objectContaining({
            id: fixture.completionRecommendationIds.expired,
            kind: "completion",
            state: "expired",
            canReview: false,
          }),
        }),
      ]),
    );
    expect(body.brief.sections.untracked_followups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "QA: Send launch recap to the customer",
          review: expect.objectContaining({
            id: fixture.seedCandidateIds.track,
            kind: "seed",
            state: "pending",
            canReview: true,
          }),
        }),
      ]),
    );

    const completion = await app.request(
      `/api/task-completion-recommendations/${fixture.completionRecommendationIds.confirmDone}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "confirm_done" }),
      },
    );
    expect(completion.status).toBe(200);
    await expect(completion.json()).resolves.toMatchObject({
      review: { state: "accepted", canReview: false },
      task: { status: "done" },
    });

    const keepOpen = await app.request(
      `/api/task-completion-recommendations/${fixture.completionRecommendationIds.keepOpen}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "keep_open" }),
      },
    );
    expect(keepOpen.status).toBe(200);
    await expect(keepOpen.json()).resolves.toMatchObject({
      review: { state: "rejected", canReview: false },
      task: { status: "open" },
    });

    const expired = await app.request(
      `/api/task-completion-recommendations/${fixture.completionRecommendationIds.expired}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "confirm_done" }),
      },
    );
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toMatchObject({ error: { code: "REVIEW_STALE" } });

    const track = await app.request(`/api/task-seed-candidates/${fixture.seedCandidateIds.track}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "track" }),
    });
    expect(track.status).toBe(200);
    await expect(track.json()).resolves.toMatchObject({
      review: { state: "accepted", canReview: false },
      task: { title: "QA: Send launch recap to the customer", status: "open" },
    });

    const dismiss = await app.request(`/api/task-seed-candidates/${fixture.seedCandidateIds.dismiss}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "dismiss" }),
    });
    expect(dismiss.status).toBe(200);
    await expect(dismiss.json()).resolves.toMatchObject({
      review: { state: "dismissed", canReview: false, acceptedTaskId: null },
      task: null,
    });
  });

  it("isolates copied runtime state from live channels, tools, syncs, and schedules", async () => {
    await db
      .insertInto("settings")
      .values({
        id: "default",
        slack_bot_token: "xoxb-live",
        slack_app_token: "xapp-live",
        smtp_host: "smtp.example.com",
        smtp_port: 587,
        smtp_from: "sketch@example.com",
        llm_provider: "anthropic",
        anthropic_api_key: "live-llm-key",
      })
      .execute();
    await db
      .updateTable("users")
      .set({ slack_user_id: "U-LIVE", whatsapp_number: "+15551234567" })
      .where("id", "=", USER_ID)
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "fixture-connector",
        connector_type: "linear",
        auth_type: "api_key",
        credentials: "{}",
        sync_status: "active",
        created_by: USER_ID,
      })
      .execute();
    await db
      .insertInto("scheduled_tasks")
      .values({
        id: "fixture-schedule",
        platform: "slack",
        context_type: "dm",
        delivery_target: "D-LIVE",
        prompt: "Send a live message",
        schedule_type: "cron",
        schedule_value: "0 * * * *",
        status: "active",
        created_by: USER_ID,
      })
      .execute();
    await db
      .insertInto("agent_user_configs")
      .values({
        agent_key: "daily_brief",
        user_id: USER_ID,
        enabled: 1,
      })
      .execute();
    await db
      .insertInto("mcp_servers")
      .values({
        id: "fixture-mcp",
        slug: "live-tool",
        display_name: "Live tool",
        url: "https://example.com/mcp",
        credentials: "{}",
      })
      .execute();
    await db
      .insertInto("agent_environment_variables")
      .values({
        id: "fixture-agent-env",
        user_id: USER_ID,
        name: "LIVE_API_KEY",
        value: "live-secret",
      })
      .execute();
    await db
      .insertInto("agent_environment_variable_shares")
      .values({
        id: "fixture-agent-env-share",
        variable_id: "fixture-agent-env",
        variable_name: "LIVE_API_KEY",
        target_type: "user",
        target_id: USER_ID,
        created_by: USER_ID,
      })
      .execute();
    await db.insertInto("whatsapp_creds").values({ id: "default", creds: "{}" }).execute();
    await db.insertInto("whatsapp_keys").values({ type: "session", key_id: "live-key", value: "{}" }).execute();

    await expect(isolateFollowupReviewQaDatabase(db, NOW)).resolves.toMatchObject({
      settingsDisconnected: 1,
      usersDisconnected: 1,
      connectorsDisabled: 1,
      scheduledTasksPaused: 1,
      agentConfigsDisabled: 1,
      dailyBriefConfigsDisabled: 1,
      agentEnvironmentVariablesRemoved: 1,
      agentEnvironmentVariableSharesRemoved: 1,
      mcpServersRemoved: 1,
      whatsappCredentialsRemoved: 1,
      whatsappKeysRemoved: 1,
    });
    await expect(
      db
        .selectFrom("settings")
        .select(["slack_bot_token", "slack_app_token", "smtp_host", "llm_provider", "anthropic_api_key"])
        .executeTakeFirst(),
    ).resolves.toEqual({
      slack_bot_token: null,
      slack_app_token: null,
      smtp_host: null,
      llm_provider: null,
      anthropic_api_key: null,
    });
    await expect(
      db.selectFrom("users").select(["slack_user_id", "whatsapp_number"]).where("id", "=", USER_ID).executeTakeFirst(),
    ).resolves.toEqual({
      slack_user_id: null,
      whatsapp_number: null,
    });
    await expect(db.selectFrom("connector_configs").select("sync_status").executeTakeFirst()).resolves.toEqual({
      sync_status: "disabled",
    });
    await expect(
      db.selectFrom("scheduled_tasks").select(["status", "next_run_at"]).executeTakeFirst(),
    ).resolves.toEqual({
      status: "paused",
      next_run_at: null,
    });
    await expect(db.selectFrom("agent_user_configs").select("enabled").executeTakeFirst()).resolves.toEqual({
      enabled: 0,
    });
    await expect(db.selectFrom("mcp_servers").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("agent_environment_variables").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("agent_environment_variable_shares").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("whatsapp_creds").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("whatsapp_keys").select("key_id").execute()).resolves.toEqual([]);
  });

  it("resets its own namespace without duplicating cards and can be cleared", async () => {
    await seedInlineFollowupReviewFixture(db, { userId: USER_ID, now: NOW });
    await seedInlineFollowupReviewFixture(db, { userId: USER_ID, now: NOW });
    const app = createFixtureApp(db);

    const latest = await app.request(`/api/daily-briefs?date=${OUTPUT_DATE}`);
    const body = (await latest.json()) as {
      brief: { sections: Record<string, Array<{ title: string }>> };
    };
    expect(body.brief.sections.looks_resolved?.map((item) => item.title)).toEqual([
      "QA: Confirm completed launch checklist",
      "QA: Keep customer handoff open",
      "QA: Review an expired completion suggestion",
    ]);
    expect(body.brief.sections.untracked_followups?.map((item) => item.title)).toEqual([
      "QA: Send launch recap to the customer",
      "QA: Remove duplicate launch reminder",
      "QA: Legacy chat-only follow-up",
    ]);

    await clearInlineFollowupReviewFixture(db, USER_ID);

    const cleared = await app.request(`/api/daily-briefs?date=${OUTPUT_DATE}`);
    await expect(cleared.json()).resolves.toMatchObject({ brief: null });
  });

  function createFixtureApp(database: Kysely<DB>) {
    const runAgent = async () => {
      throw new Error("Fixture tests do not run an agent.");
    };
    const service = new AgentRunService({
      db: database,
      config: createTestConfig(),
      logger: createTestLogger(),
      users: createUserRepository(database),
      settings: createSettingsRepository(database),
      runAgent: runAgent as AgentRunServiceDeps["runAgent"],
      runScheduledAgent: runAgent as AgentRunServiceDeps["runScheduledAgent"],
    });
    const routeService = {
      resolveUserId: async () => USER_ID,
      getLatestForUser: service.getLatestForUser.bind(service),
      getByIdForUser: service.getByIdForUser.bind(service),
    } as unknown as AgentRunService;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sub", "fixture-auth-sub");
      c.set("email", "fixture-reviewer@example.com");
      c.set("role", "admin");
      c.set("adminCanReadAllFiles", false);
      await next();
    });
    app.route("/api/daily-briefs", dailyBriefRoutes(routeService, database, createTestLogger()));
    app.route("/api", followupReviewRoutes(routeService, database));
    return app;
  }
});
