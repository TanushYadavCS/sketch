import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDeliveryModel,
  type AgentOutputItemInput,
  type AgentRoute,
  type AgentSourceConfig,
  createAgentOutputRepository,
} from "../db/repositories/agent-outputs";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import type { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppBot } from "../whatsapp/bot";
import { CONVERSATION_SUMMARY_AGENT_KEY, conversationSummaryDefinition } from "./definitions/conversation-summary";
import { DAILY_BRIEF_AGENT_KEY, DAILY_BRIEF_AGENT_VERSION, dailyBriefDefinition } from "./definitions/daily-brief";
import type { AgentOutputDeliveryPublisher } from "./output-delivery";
import { AgentRunService, type AgentRunServiceDeps, scopeKeyForRoute } from "./service";
import {
  NOW,
  OUTPUT_DATE,
  allowSlackDelivery,
  briefItem,
  createPausedQueueManager,
  createService,
  createWritingService,
  emptySummaryPayload,
  perSourceSelfModel,
  runtimeContextFromUserMessage,
  seedEntity,
  seedIndexedFile,
  seedMention,
  seedPersonEntity,
  seedSlackConversationMessage,
  slackSource,
  sourceRoute,
  successfulRunResult,
  whatsappSource,
} from "./service-test-helpers";

describe("AgentRunService", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  it("keeps the legacy config-control resolver scoped to the viewer while admin lists aggregate Summarizer configs", async () => {
    const users = createUserRepository(db);
    const adminA = await users.create({
      name: "Admin A",
      email: "admin-a@example.com",
      slackUserId: "U_ADMIN_A",
      authRole: "admin",
    });
    const adminB = await users.create({
      name: "Admin B",
      email: "admin-b@example.com",
      slackUserId: "U_ADMIN_B",
      authRole: "admin",
    });
    const source = slackSource("C_A", "alpha");
    const route = sourceRoute(source);
    const service = createService(db, [], allowSlackDelivery([{ id: "C_A", name: "alpha" }]));

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, adminA.id, {
      sources: [source],
      routes: [route],
    });

    await expect(service.resolveConfigControlUserId(CONVERSATION_SUMMARY_AGENT_KEY, adminB.id, "admin")).resolves.toBe(
      adminB.id,
    );

    const summaries = await service.listForViewer(adminB.id, "admin");
    expect(summaries.find((summary) => summary.key === CONVERSATION_SUMMARY_AGENT_KEY)).toMatchObject({
      sources: [source],
      routes: [
        expect.objectContaining({
          ...route,
          id: expect.stringMatching(/^org:/),
          owner: expect.objectContaining({ userId: adminA.id, name: "Admin A", authRole: "admin" }),
        }),
      ],
    });
  });

  it("keeps admin Summarizer control on self when no admin config exists", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      authRole: "admin",
    });
    const service = createService(db, []);

    await expect(service.resolveConfigControlUserId(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin")).resolves.toBe(
      admin.id,
    );
  });

  it("keeps members and non-Summarizer agents scoped to the viewer", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      slackUserId: "U_ADMIN",
      authRole: "admin",
    });
    const member = await users.create({ name: "Member", email: "member@example.com", authRole: "member" });
    const source = slackSource("C_A", "alpha");
    const service = createService(db, [], allowSlackDelivery([{ id: "C_A", name: "alpha" }]));

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, {
      sources: [source],
      routes: [sourceRoute(source)],
    });

    await expect(service.resolveConfigControlUserId(CONVERSATION_SUMMARY_AGENT_KEY, member.id, "member")).resolves.toBe(
      member.id,
    );
    await expect(service.resolveConfigControlUserId(DAILY_BRIEF_AGENT_KEY, admin.id, "admin")).resolves.toBe(admin.id);
  });

  it("lists org-wide Summarizer configs for admins across member and admin owners", async () => {
    const users = createUserRepository(db);
    const adminA = await users.create({
      name: "Admin A",
      email: "admin-a@example.com",
      slackUserId: "U_ADMIN_A",
      authRole: "admin",
    });
    const adminB = await users.create({
      name: "Admin B",
      email: "admin-b@example.com",
      slackUserId: "U_ADMIN_B",
      authRole: "admin",
    });
    const member = await users.create({
      name: "Maya Member",
      email: "maya@example.com",
      slackUserId: "U_MAYA",
      authRole: "member",
    });
    const adminSource = slackSource("C_ADMIN", "admin-source");
    const memberSource = slackSource("C_MEMBER", "member-source");
    const service = createService(
      db,
      [],
      allowSlackDelivery([
        { id: "C_ADMIN", name: "admin-source" },
        { id: "C_MEMBER", name: "member-source" },
      ]),
    );

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, adminA.id, {
      sources: [adminSource],
      routes: [sourceRoute(adminSource, { focus: "Admin route" })],
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, member.id, {
      sources: [memberSource],
      routes: [sourceRoute(memberSource, { focus: "Member route" })],
    });

    const summaries = await service.listForViewer(adminB.id, "admin");
    const summary = summaries.find((item) => item.key === CONVERSATION_SUMMARY_AGENT_KEY);

    expect(summary?.sources).toHaveLength(2);
    expect(summary?.sources).toEqual(expect.arrayContaining([adminSource, memberSource]));
    expect(summary?.routes).toHaveLength(2);
    expect(summary?.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^org:/),
          sources: [`slack:channel:${adminSource.targetId}`],
          focus: "Admin route",
          owner: expect.objectContaining({ userId: adminA.id, name: "Admin A", authRole: "admin" }),
        }),
        expect.objectContaining({
          id: expect.stringMatching(/^org:/),
          sources: [`slack:channel:${memberSource.targetId}`],
          focus: "Member route",
          owner: expect.objectContaining({ userId: member.id, name: "Maya Member", authRole: "member" }),
        }),
      ]),
    );
  });

  it("lets admins update a member-owned Summarizer route without moving ownership", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      slackUserId: "U_ADMIN",
      authRole: "admin",
    });
    const member = await users.create({
      name: "Maya Member",
      email: "maya@example.com",
      slackUserId: "U_MAYA",
      authRole: "member",
    });
    const source = slackSource("C_MEMBER", "member-source");
    const service = createService(db, [], allowSlackDelivery([{ id: "C_MEMBER", name: "member-source" }]));

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, member.id, {
      sources: [source],
      routes: [sourceRoute(source)],
    });
    const adminView = await service.getConfigViewForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin");
    const disabledRoutes =
      adminView?.routes.map((route) => (route.owner?.userId === member.id ? { ...route, enabled: false } : route)) ??
      [];

    await service.updateConfigForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin", {
      routes: disabledRoutes,
    });

    const memberView = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, member.id);
    const adminOwnConfig = await createAgentOutputRepository(db).getConfig(CONVERSATION_SUMMARY_AGENT_KEY, admin.id);
    expect(memberView?.routes).toEqual([
      expect.objectContaining({ id: `slack:channel:${source.targetId}`, enabled: false }),
    ]);
    expect(adminOwnConfig.exists).toBe(false);
  });

  it("stores new unowned routes created from an admin org-wide view under that admin", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      slackUserId: "U_ADMIN",
      authRole: "admin",
    });
    const member = await users.create({
      name: "Maya Member",
      email: "maya@example.com",
      slackUserId: "U_MAYA",
      authRole: "member",
    });
    const memberSource = slackSource("C_MEMBER", "member-source");
    const adminSource = slackSource("C_ADMIN", "admin-source");
    const service = createService(
      db,
      [],
      allowSlackDelivery([
        { id: "C_MEMBER", name: "member-source" },
        { id: "C_ADMIN", name: "admin-source" },
      ]),
    );

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, member.id, {
      sources: [memberSource],
      routes: [sourceRoute(memberSource)],
    });
    const adminView = await service.getConfigViewForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin");
    const newAdminRoute = sourceRoute(adminSource, { focus: "Admin-created route" });

    await service.updateConfigForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin", {
      sources: [memberSource, adminSource],
      routes: [...(adminView?.routes ?? []), newAdminRoute],
    });

    const memberView = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, member.id);
    const adminViewAfterSave = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, admin.id);
    expect(memberView?.routes).toHaveLength(1);
    expect(adminViewAfterSave?.routes).toEqual([
      expect.objectContaining({ id: newAdminRoute.id, focus: "Admin-created route" }),
    ]);
  });

  it("lists org-wide Summarizer outputs for admins", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({ name: "Admin", email: "admin@example.com", authRole: "admin" });
    const member = await users.create({ name: "Maya Member", email: "maya@example.com", authRole: "member" });
    const service = createService(db, []);
    const repo = createAgentOutputRepository(db);
    const now = new Date().toISOString();
    await db
      .insertInto("agent_outputs")
      .values([
        {
          id: "admin-output",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: admin.id,
          output_date: OUTPUT_DATE,
          period_key: OUTPUT_DATE,
          source_key: "slack:channel:C_ADMIN",
          source_label: "#admin-source",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: conversationSummaryDefinition.version,
          agent_run_id: null,
          masthead_json: JSON.stringify({ title: "Admin", summary: "Admin summary" }),
          raw_payload_json: "{}",
          error_message: null,
          generated_at: "2026-06-15T10:00:00.000Z",
          created_at: now,
          updated_at: now,
        },
        {
          id: "member-output",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: member.id,
          output_date: OUTPUT_DATE,
          period_key: OUTPUT_DATE,
          source_key: "slack:channel:C_MEMBER",
          source_label: "#member-source",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: conversationSummaryDefinition.version,
          agent_run_id: null,
          masthead_json: JSON.stringify({ title: "Member", summary: "Member summary" }),
          raw_payload_json: "{}",
          error_message: null,
          generated_at: "2026-06-15T11:00:00.000Z",
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    const outputs = await service.listOutputsForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin", {
      limit: 10,
    });
    const memberOnlyOutputs = await service.listOutputsForViewer(CONVERSATION_SUMMARY_AGENT_KEY, member.id, "member", {
      limit: 10,
    });

    expect(outputs.outputs.map((output) => output.id)).toEqual(["member-output", "admin-output"]);
    expect(memberOnlyOutputs.outputs.map((output) => output.id)).toEqual(["member-output"]);
    expect(
      (await repo.listCompletedForUser(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, { limit: 10 })).outputs,
    ).toHaveLength(1);
  });

  it("resolves WhatsApp group sources by bot-known group membership without requiring a user WhatsApp number", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const source = whatsappSource("120363000000001@g.us", "Spoofed");
    await createWhatsAppGroupRepository(db).upsert({
      jid: source.targetId,
      name: "Leadership",
      description: null,
      updated_at: "2026-06-27T00:00:00.000Z",
    });
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ id: "86702773280883@lid" }],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata }) });

    const updated = await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      sources: [source],
    });

    expect(updated?.sources).toEqual([
      {
        platform: "whatsapp",
        targetType: "group",
        targetId: "120363000000001@g.us",
        label: "Leadership",
      },
    ]);
    expect(getGroupMetadata).not.toHaveBeenCalled();
  });

  it("rejects WhatsApp group sources that are not known to the bot", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          id: "120363000000404@g.us",
          owner: "15550000000@s.whatsapp.net",
          subject: "Unknown",
          participants: [],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata }) });

    await expect(
      service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
        sources: [whatsappSource("120363000000404@g.us", "Unknown")],
      }),
    ).rejects.toThrow("WhatsApp group is not available as a source");
    expect(getGroupMetadata).not.toHaveBeenCalled();
  });

  it("keeps Slack source validation strict to current-user channel membership", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const isUserInChannel = vi.fn(async () => false);
    const service = createService(db, [], {
      getSlack: () => ({
        listChannels: vi.fn(async () => [
          { id: "C_PRIVATE", name: "private-room", type: "private_channel", isMember: true },
        ]),
        isUserInChannel,
      }),
    });

    await expect(
      service.resolveSourceConfigsForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, [
        slackSource("C_PRIVATE", "private-room"),
      ]),
    ).rejects.toThrow("Slack channel is not available for this user");
    expect(isUserInChannel).toHaveBeenCalledWith("C_PRIVATE", "U_AGENT");
  });

  it("normalizes delivery models with defaultRoute and full-key legacy matching", async () => {
    const users = createUserRepository(db);
    const slackDelivery = allowSlackDelivery([
      { id: "C_A", name: "alpha" },
      { id: "C_B", name: "beta" },
      { id: "U_AGENT", name: "user-like-channel" },
    ]);

    const defaultRouteUser = await users.create({
      name: "Default Route User",
      email: "default-route@example.com",
      slackUserId: "U_DEFAULT",
    });
    const defaultRouteService = createService(db, [], slackDelivery);
    await defaultRouteService.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, defaultRouteUser.id, {
      sources: [slackSource("C_A", "alpha")],
      deliveryModel: perSourceSelfModel(),
    });
    const reconciled = await defaultRouteService.updateConfigForUser(
      CONVERSATION_SUMMARY_AGENT_KEY,
      defaultRouteUser.id,
      {
        sources: [slackSource("C_A", "alpha"), slackSource("C_B", "beta")],
      },
    );

    expect(reconciled?.deliveryModel).toMatchObject({
      mode: "per_source",
      defaultRoute: "self",
      perSource: {
        "slack:channel:C_A": { kind: "self" },
        "slack:channel:C_B": { kind: "self" },
      },
    });

    const fullKeyUser = await users.create({
      name: "Full Key User",
      email: "full-key@example.com",
      slackUserId: "U_AGENT",
    });
    const fullKeyService = createService(db, [], slackDelivery);
    const fullKeyConfig = await fullKeyService.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, fullKeyUser.id, {
      sources: [slackSource("U_AGENT", "user-like-channel")],
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "dm",
        targetId: "U_AGENT",
        label: "Self DM",
      },
    });

    expect(fullKeyConfig?.deliveryModel).toMatchObject({
      mode: "combined",
      combined: { targetType: "dm", targetId: "U_AGENT" },
    });
  });
});
