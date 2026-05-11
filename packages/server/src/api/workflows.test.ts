import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import type { SlackBot } from "../slack/bot";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const API_KEY = "sk_live_test_key";

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdk.query,
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

async function readSse(res: Response) {
  return res.text();
}

function sseData(text: string, event: string) {
  const block = text.split("\n\n").find((entry) => entry.split("\n").some((line) => line === `event: ${event}`));
  if (!block) return undefined;
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  return data ? JSON.parse(data) : undefined;
}

function sseEvents(text: string, event: string) {
  return text
    .split("\n\n")
    .filter((entry) => entry.split("\n").some((line) => line === `event: ${event}`))
    .map((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      return data ? JSON.parse(data) : undefined;
    });
}

function mockLightResult(text = "workflow result") {
  sdk.query.mockImplementation(() => {
    return (async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      };
      yield { type: "result", session_id: "sess-light", total_cost_usd: 0 };
    })();
  });
}

async function seedTenant(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword("testpassword123");
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString(), sketchApiKey: API_KEY });
  await users.create({
    name: "Admin",
    email: "admin@test.com",
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
    slackUserId: "SADMIN",
  });
  const requester = await users.create({
    name: "Requester",
    email: "requester@test.com",
    emailVerified: true,
    slackUserId: "SREQ",
  });
  return { requester };
}

async function createWorkflow(
  db: Kysely<DB>,
  params: {
    createdBy: string | null;
    status?: "active" | "paused" | "completed";
    deliveryTarget?: string;
    outputTarget?: string | null;
    sessionMode?: "fresh" | "persistent" | "chat";
    threadTs?: string | null;
    steps?: Array<Record<string, unknown>>;
    contentType?: "prompt" | "script";
    content?: string;
  },
) {
  const repo = createScheduledTaskRepository(db);
  const stepContent = createAutomationStepContentRepository(db);
  const steps = params.steps ?? [
    { id: "trigger", type: "trigger", label: "API", icon: "bolt", position: { x: 0, y: 0 } },
    {
      id: "step1",
      type: "agent",
      label: "Summarize",
      icon: "sketch-ai",
      position: { x: 0, y: 100 },
      agentMode: "light",
    },
  ];
  const task = await repo.add({
    platform: "slack",
    context_type: "channel",
    delivery_target: params.deliveryTarget ?? "C123",
    thread_ts: params.threadTs ?? null,
    prompt: "Workflow prompt",
    schedule_type: "cron",
    schedule_value: "0 9 * * *",
    timezone: "UTC",
    session_mode: params.sessionMode ?? "fresh",
    status: params.status ?? "active",
    next_run_at: null,
    last_run_at: null,
    created_by: params.createdBy,
    title: "External workflow",
    description: "Safe workflow metadata",
    steps: JSON.stringify(steps),
    edges: null,
    output_target: params.outputTarget ?? null,
    output_platform: null,
  });
  await stepContent.upsert({
    taskId: task.id,
    stepId: "step1",
    contentType: params.contentType ?? "prompt",
    content: params.content ?? "Return a concise workflow result.",
  });
  return task;
}

describe("workflow invoke API", () => {
  let db: Kysely<DB>;
  let dataDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-workflow-runs-"));
    sdk.query.mockReset();
    mockLightResult();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("rejects workflow routes without the Sketch API key", async () => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: requester.id });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const listRes = await app.request("/api/workflows");
    expect(listRes.status).toBe(401);

    const runRes = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ requesterUserId: requester.id }),
    });
    expect(runRes.status).toBe(401);
  });

  it("lists active workflows with safe metadata", async () => {
    const { requester } = await seedTenant(db);
    const active = await createWorkflow(db, { createdBy: requester.id });
    await createWorkflow(db, { createdBy: requester.id, status: "paused" });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const res = await app.request("/api/workflows", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0]).toMatchObject({
      id: active.id,
      title: "External workflow",
      status: "active",
      platform: "slack",
      contextType: "channel",
      stepCount: 1,
    });
    expect(body.workflows[0].prompt).toBeUndefined();
    expect(body.workflows[0].steps).toBeUndefined();
  });

  it("streams a silent workflow run and persists trigger data", async () => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: requester.id });
    const slack = { postMessage: vi.fn() } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      getSlack: () => slack,
    });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        triggerData: { payload: { customerId: "cus_123" } },
      }),
    });
    expect(res.status).toBe(200);
    const text = await readSse(res);
    const started = sseData(text, "run.started");
    const completed = sseData(text, "completed");
    expect(started.workflowId).toBe(task.id);
    expect(completed).toMatchObject({
      ok: true,
      workflowId: task.id,
      status: "completed",
      finalOutput: "workflow result",
      delivery: { mode: "silent" },
    });
    expect(sseEvents(text, "step.started")).toHaveLength(1);
    expect(sseEvents(text, "step.completed")).toHaveLength(1);
    expect(slack.postMessage).not.toHaveBeenCalled();

    const runRes = await app.request(`/api/workflows/${task.id}/runs/${completed.runId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    expect(runBody.run.trigger_data).toMatchObject({
      source: "external-api",
      requesterUserId: requester.id,
      data: { payload: { customerId: "cus_123" } },
    });
    expect(runBody.run.step_outputs.step1.output).toBe("workflow result");
  });

  it("runs Canvas-style requests as JSON using the workflow creator as requester", async () => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: requester.id });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        responseMode: "json",
        source: "canvas",
        canvasWorkflowId: "canvas-workflow-1",
        canvasTriggerNodeId: "trigger-node-1",
        canvasActionNodeId: "sketch-action-node-1",
        canvasRunId: "canvas-run-1",
        triggerComponentKey: "linear-new-issue",
        triggerData: { issue: { title: "Fix onboarding", url: "https://linear.app/test/issue/SKE-1" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      workflowId: task.id,
      status: "completed",
      finalOutput: "workflow result",
      finalOutputSummary: "workflow result",
      delivery: { mode: "silent" },
    });
    expect(body.runId).toEqual(expect.any(String));
    expect(body.stepOutputs.step1.output).toBe("workflow result");

    const runRes = await app.request(`/api/workflows/${task.id}/runs/${body.runId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    expect(runBody.run.trigger_data).toMatchObject({
      source: "canvas",
      requesterUserId: requester.id,
      canvas: {
        workflowId: "canvas-workflow-1",
        triggerNodeId: "trigger-node-1",
        actionNodeId: "sketch-action-node-1",
        runId: "canvas-run-1",
        triggerComponentKey: "linear-new-issue",
      },
      data: { issue: { title: "Fix onboarding", url: "https://linear.app/test/issue/SKE-1" } },
    });
  });

  it("returns ok false for failed JSON workflow runs", async () => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: requester.id });
    sdk.query.mockImplementation(() => {
      throw new Error("boom");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        responseMode: "json",
        source: "canvas",
        triggerData: { issue: { title: "Fix onboarding" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      workflowId: task.id,
      status: "failed",
      finalOutput: null,
      finalOutputSummary: null,
      delivery: { mode: "silent" },
    });
    expect(body.stepOutputs.step1.status).toBe("failed");
    expect(body.stepOutputs.step1.error.message).toBe("boom");
  });

  it("returns a clear error when no requester or workflow creator can be resolved", async () => {
    await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: null });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ responseMode: "json", source: "canvas" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "REQUESTER_NOT_FOUND",
        message: "Workflow requester could not be resolved",
      },
    });
  });

  it.each(["paused", "completed"] as const)("returns persisted runs after a workflow is %s", async (status) => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: requester.id });
    const taskRepo = createScheduledTaskRepository(db);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ requesterUserId: requester.id }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");
    await taskRepo.updateStatus(task.id, status);

    const runRes = await app.request(`/api/workflows/${task.id}/runs/${completed.runId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    expect(runBody.run.id).toBe(completed.runId);
    expect(runBody.run.task_id).toBe(task.id);
    expect(runBody.run.status).toBe("completed");
  });

  it("delivers final output to the workflow target in target mode", async () => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: requester.id, deliveryTarget: "C999" });
    const slack = { postMessage: vi.fn().mockResolvedValue("1712345678.000000") } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      getSlack: () => slack,
    });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ requesterUserId: requester.id, deliveryMode: "target" }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");
    expect(slack.postMessage).toHaveBeenCalledWith("C999", "workflow result");
    expect(completed.delivery).toEqual({
      mode: "target",
      platform: "slack",
      target: "C999",
      messageRef: "1712345678.000000",
    });
  });

  it("posts a top-level Slack message when output target differs from the source thread channel", async () => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, {
      createdBy: requester.id,
      deliveryTarget: "C_SOURCE",
      outputTarget: "C_OUTPUT",
      sessionMode: "chat",
      threadTs: "1234567890.000100",
    });
    const slack = {
      postMessage: vi.fn().mockResolvedValue("1712345678.000000"),
      postThreadReply: vi.fn().mockResolvedValue("1712345678.000001"),
    } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      getSlack: () => slack,
    });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ requesterUserId: requester.id, deliveryMode: "target" }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");
    expect(slack.postThreadReply).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenCalledWith("C_OUTPUT", "workflow result");
    expect(completed.delivery).toEqual({
      mode: "target",
      platform: "slack",
      target: "C_OUTPUT",
      messageRef: "1712345678.000000",
    });
  });

  it("streams failed step events and persists the failed run", async () => {
    const { requester } = await seedTenant(db);
    const task = await createWorkflow(db, { createdBy: requester.id });
    sdk.query.mockImplementation(() => {
      throw new Error("boom");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const res = await app.request(`/api/workflows/${task.id}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ requesterUserId: requester.id }),
    });
    expect(res.status).toBe(200);
    const text = await readSse(res);
    const failed = sseData(text, "step.failed");
    const completed = sseData(text, "completed");
    expect(failed).toMatchObject({ workflowId: task.id, stepId: "step1", status: "failed" });
    expect(failed.error.message).toBe("boom");
    expect(completed.status).toBe("failed");

    const runRes = await app.request(`/api/workflows/${task.id}/runs/${completed.runId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const runBody = await runRes.json();
    expect(runBody.run.status).toBe("failed");
    expect(runBody.run.step_outputs.step1.status).toBe("failed");
  });
});
