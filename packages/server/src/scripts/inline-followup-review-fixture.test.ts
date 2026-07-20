import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dailyBriefRoutes, followupReviewRoutes } from "../agents/routes";
import { AgentRunService, type AgentRunServiceDeps } from "../agents/service";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { clearInlineFollowupReviewFixture, seedInlineFollowupReviewFixture } from "./inline-followup-review-fixture";

const USER_ID = "inline-followup-review-fixture-user";
const OUTPUT_DATE = "2026-07-20";
const NOW = "2026-07-20T10:00:00.000Z";

describe("inline follow-up review fixture", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
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
  });

  it("seeds a brief that can complete and track follow-ups through the public review routes", async () => {
    const fixture = await seedInlineFollowupReviewFixture(db, { userId: USER_ID, now: NOW });
    const app = createFixtureApp(db);

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

    const seed = await app.request(`/api/task-seed-candidates/${fixture.seedCandidateIds.track}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "track" }),
    });
    expect(seed.status).toBe(200);
    await expect(seed.json()).resolves.toMatchObject({
      review: { state: "accepted", canReview: false },
      task: { title: "QA: Send launch recap to the customer", status: "open" },
    });
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
