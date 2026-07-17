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

  it("routes scheduled generations separately from manual generations", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async () => {
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const service = createService(db, tasks, {
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    await tasks.shift()?.();

    expect(scheduledRunAgent).toHaveBeenCalledTimes(1);
    expect(interactiveRunAgent).not.toHaveBeenCalled();

    await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: "2026-06-16",
      triggerType: "manual",
    });
    await tasks.shift()?.();

    expect(interactiveRunAgent).toHaveBeenCalledTimes(1);
    expect(scheduledRunAgent).toHaveBeenCalledTimes(1);
  });

  it("uses independent per-agent queues for scheduled and manual generations", async () => {
    const queueKeys: string[] = [];
    const queueManager = {
      getQueue: (key: string) => {
        queueKeys.push(key);
        return { enqueue: () => true };
      },
    } as unknown as QueueManager;
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const service = createService(db, [], { queueManager });

    await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: "2026-06-16",
      triggerType: "manual",
    });

    expect(queueKeys).toEqual([
      `agent-scheduled-${DAILY_BRIEF_AGENT_KEY}-${user.id}`,
      `agent-manual-${DAILY_BRIEF_AGENT_KEY}-${user.id}`,
    ]);
  });

  it("promotes a queued scheduled generation when a manual request coalesces onto it", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async () => {
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runScheduledAgent"];
    const service = createService(db, tasks, {
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    const [scheduled] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    const [manual] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(manual.id).toBe(scheduled.id);
    expect(manual.trigger_type).toBe("manual");
    expect(tasks).toHaveLength(2);

    await tasks.shift()?.();
    expect(scheduledRunAgent).not.toHaveBeenCalled();
    expect(interactiveRunAgent).not.toHaveBeenCalled();

    await tasks.shift()?.();
    expect(interactiveRunAgent).toHaveBeenCalledTimes(1);
    expect(scheduledRunAgent).not.toHaveBeenCalled();
  });

  it("runs only one manual replacement when concurrent requests promote the same scheduled generation", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async () => {
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runScheduledAgent"];
    const service = createService(db, tasks, {
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    const [scheduled] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    const requests = await Promise.all([
      service.requestGenerationForUser({
        agentKey: DAILY_BRIEF_AGENT_KEY,
        userId: user.id,
        outputDate: OUTPUT_DATE,
        triggerType: "manual",
      }),
      service.requestGenerationForUser({
        agentKey: DAILY_BRIEF_AGENT_KEY,
        userId: user.id,
        outputDate: OUTPUT_DATE,
        triggerType: "manual",
      }),
    ]);

    expect(requests.flat().map((output) => output.id)).toEqual([scheduled.id, scheduled.id]);
    expect(requests.flat().every((output) => output.trigger_type === "manual")).toBe(true);

    for (const task of tasks) await task();

    expect(interactiveRunAgent).toHaveBeenCalledTimes(1);
    expect(scheduledRunAgent).not.toHaveBeenCalled();
  });

  it("keeps the scheduled generation when the manual replacement queue is full", async () => {
    const acceptedTasks: Array<() => Promise<void>> = [];
    let enqueueCalls = 0;
    const queueManager = {
      getQueue: () => ({
        enqueue: (task: () => Promise<void>) => {
          enqueueCalls += 1;
          if (enqueueCalls > 1) return false;
          acceptedTasks.push(task);
          return true;
        },
      }),
    } as unknown as QueueManager;
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async () => {
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runScheduledAgent"];
    const service = createService(db, [], {
      queueManager,
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    const [scheduled] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    const [manual] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(enqueueCalls).toBe(2);
    expect(acceptedTasks).toHaveLength(1);
    expect(manual.id).toBe(scheduled.id);
    expect(manual.trigger_type).toBe("scheduled");

    await acceptedTasks[0]?.();
    expect(scheduledRunAgent).toHaveBeenCalledTimes(1);
    expect(interactiveRunAgent).not.toHaveBeenCalled();
  });

  it("keeps an admitted scheduled generation instead of duplicating it for a manual request", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    let releaseScheduled!: () => void;
    const scheduledGate = new Promise<void>((resolve) => {
      releaseScheduled = resolve;
    });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async (_params, admission) => {
      admission?.onStart?.();
      await scheduledGate;
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runScheduledAgent"];
    const service = createService(db, tasks, {
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    const [scheduled] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    const runningTask = tasks.shift()?.();
    await vi.waitFor(() => expect(scheduledRunAgent).toHaveBeenCalledTimes(1));

    const [manual] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(manual.id).toBe(scheduled.id);
    expect(manual.trigger_type).toBe("scheduled");
    expect(tasks).toHaveLength(0);
    expect(interactiveRunAgent).not.toHaveBeenCalled();

    releaseScheduled();
    await runningTask;
  });

  it("uses the latest delivery config after a scheduled run completes", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await seedEntity(db, { id: "entity-delivery-latest", name: "Delivery Latest Project" });
    const outputDelivery = {
      deliver: vi.fn(async () => {}),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery([
      { id: "C_OLD", name: "old" },
      { id: "C_NEW", name: "new" },
    ]);
    const service = createWritingService(
      db,
      tasks,
      briefItem({ knowledgeRefs: { entityIds: ["entity-delivery-latest"], fileIds: [] } }),
      outputDelivery,
      async () => {
        await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
          delivery: {
            enabled: true,
            platform: "slack",
            targetType: "channel",
            targetId: "C_NEW",
            label: "#new",
          },
        });
      },
      slackDelivery,
    );
    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_OLD",
        label: "#old",
      },
    });

    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();

    expect(outputDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(slackDelivery.isUserInChannel).toHaveBeenCalledWith("C_NEW", "U_AGENT");
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ targetId: "C_NEW" }),
      }),
    );
  });

  it("delivers manual outputs when delivery is configured", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await seedEntity(db, { id: "entity-manual", name: "Manual Project" });
    const outputDelivery = {
      deliver: vi.fn(async () => {}),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery();
    const service = createWritingService(
      db,
      tasks,
      briefItem({ knowledgeRefs: { entityIds: ["entity-manual"], fileIds: [] } }),
      outputDelivery,
      undefined,
      slackDelivery,
    );
    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
      },
    });

    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();

    expect(outputDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(slackDelivery.isUserInChannel).toHaveBeenCalledWith("C_DAILY", "U_AGENT");
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ targetId: "C_DAILY" }),
        output: expect.objectContaining({ id: row.id, outputDate: OUTPUT_DATE }),
      }),
    );
  });

  it("keeps the brief completed when scheduled delivery fails", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await seedEntity(db, { id: "entity-delivery-failure", name: "Delivery Failure Project" });
    const outputDelivery = {
      deliver: vi.fn(async () => {
        throw new Error("Slack unavailable");
      }),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery();
    const service = createWritingService(
      db,
      tasks,
      briefItem({ knowledgeRefs: { entityIds: ["entity-delivery-failure"], fileIds: [] } }),
      outputDelivery,
      undefined,
      slackDelivery,
    );
    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
      },
    });

    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();

    const output = await db
      .selectFrom("agent_outputs")
      .select(["status", "error_message"])
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(output.status).toBe("completed");
    expect(output.error_message).toBeNull();
    expect(outputDelivery.deliver).toHaveBeenCalledTimes(1);
  });
});
