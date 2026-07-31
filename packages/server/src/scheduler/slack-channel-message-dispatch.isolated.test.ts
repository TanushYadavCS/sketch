import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { ExecuteAutomationParams } from "../workflows/runtime";
import { TaskScheduler } from "./service";

let executionParams: ExecuteAutomationParams[] = [];

vi.mock("../workflows/runtime", () => ({
  executeAutomation: vi.fn().mockImplementation(async (params: ExecuteAutomationParams) => {
    executionParams.push(params);
    return { runId: "run-1", status: "completed", finalOutput: null, stepOutputs: {} };
  }),
  resolveAutomationWorkspaceDir: (dataDir: string, task: { context_type: string; created_by: string | null }) =>
    `${dataDir}/workspaces/${task.context_type === "dm" ? task.created_by : "channel-C_OUT"}`,
  testAutomationStep: vi.fn(),
}));

function makeDeps(db: Kysely<DB>) {
  const slack = {
    postMessage: vi.fn(),
    postThreadReply: vi.fn(),
    isUserInChannel: vi.fn().mockResolvedValue(true),
  };
  return {
    db,
    config: createTestConfig({ DATA_DIR: "/tmp/slack-trigger-test" }),
    logger: createTestLogger(),
    queueManager: new QueueManager(),
    getSlack: () => slack,
    whatsapp: { isConnected: false },
    settingsRepo: { get: vi.fn().mockResolvedValue({}) },
    runAgent: vi.fn(),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
    automationRunsRepo: {
      create: vi.fn().mockResolvedValue("run-1"),
      update: vi.fn().mockResolvedValue(undefined),
    },
    stepContentRepo: { getByTask: vi.fn().mockResolvedValue([]) },
    userRepo: { findById: vi.fn().mockResolvedValue({ id: "user-1", slack_user_id: "U_CREATOR" }) },
  };
}

const baseTask = {
  platform: "slack" as const,
  context_type: "channel" as const,
  delivery_target: "C_OUT",
  thread_ts: null,
  prompt: "Handle Slack event",
  schedule_type: "external",
  schedule_value: "slack_channel_message",
  timezone: "UTC",
  session_mode: "fresh",
  created_by: "user-1",
  status: "active" as const,
  next_run_at: null,
  output_mode: "silent" as const,
};

function slackTrigger(channelId: string) {
  return JSON.stringify([
    {
      id: "trigger",
      type: "trigger",
      label: "Slack channel message",
      icon: "slack",
      position: { x: 0, y: 0 },
      triggerConfig: { type: "slack_channel_message", channelId },
    },
  ]);
}

describe("TaskScheduler.dispatchSlackChannelMessage", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createScheduledTaskRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createScheduledTaskRepository(db);
    executionParams = [];
  });

  afterEach(async () => {
    await db.destroy();
    await rm("/tmp/slack-trigger-test", { recursive: true, force: true });
  });

  it("dispatches an active exact-channel trigger once and preserves its object payload", async () => {
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const deps = makeDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const triggerData = { messageTs: "1.2", nested: { exact: true } };

    await scheduler.dispatchSlackChannelMessage("C_MATCH", triggerData);

    await vi.waitFor(() => expect(executionParams).toHaveLength(1));
    expect(deps.getSlack().isUserInChannel).toHaveBeenCalledWith("C_MATCH", "U_CREATOR");
    expect(executionParams[0]?.triggerData).toBe(triggerData);
  });

  it("copies authenticated Slack files into each automation workspace before dispatch", async () => {
    const sourcePath = "/tmp/slack-trigger-test/workspaces/channel-C_MATCH/attachments/source.jpeg";
    await mkdir("/tmp/slack-trigger-test/workspaces/channel-C_MATCH/attachments", { recursive: true });
    await writeFile(sourcePath, "jpeg-bytes");
    await repo.add({
      ...baseTask,
      context_type: "dm",
      delivery_target: "D_USER",
      steps: slackTrigger("C_MATCH"),
    });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById").mockResolvedValue(undefined);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", {
      messageTs: "1.2",
      files: [
        {
          name: "source.jpeg",
          mimetype: "image/jpeg",
          size: 10,
          urlPrivate: "https://files.slack.com/source.jpeg",
          localPath: sourcePath,
        },
      ],
    });

    expect(enqueueTaskById).toHaveBeenCalledOnce();
    const triggerData = enqueueTaskById.mock.calls[0]?.[1] as { files: Array<{ localPath: string }> };
    expect(triggerData.files[0]?.localPath).toMatch(
      /^(?:\/private)?\/tmp\/slack-trigger-test\/automation-trigger-files\/[^/]+\//,
    );
    await expect(readFile(triggerData.files[0]?.localPath ?? "", "utf8")).resolves.toBe("jpeg-bytes");
  });

  it("removes the isolated trigger file workspace after execution", async () => {
    const sourcePath = "/tmp/slack-trigger-test/workspaces/channel-C_MATCH/attachments/source.jpeg";
    await mkdir("/tmp/slack-trigger-test/workspaces/channel-C_MATCH/attachments", { recursive: true });
    await writeFile(sourcePath, "jpeg-bytes");
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", {
      files: [{ name: "source.jpeg", localPath: sourcePath }],
    });

    await vi.waitFor(() => expect(executionParams).toHaveLength(1));
    const triggerData = executionParams[0]?.triggerData as { files: Array<{ localPath: string }> };
    await vi.waitFor(async () => {
      await expect(readFile(triggerData.files[0]?.localPath ?? "", "utf8")).rejects.toThrow();
    });
  });

  it("rejects Slack trigger file symlinks that escape the source channel workspace", async () => {
    const attachmentsDir = "/tmp/slack-trigger-test/workspaces/channel-C_MATCH/attachments";
    const outsidePath = "/tmp/slack-trigger-test/outside.txt";
    const sourcePath = `${attachmentsDir}/source.txt`;
    await mkdir(attachmentsDir, { recursive: true });
    await writeFile(outsidePath, "sensitive-bytes");
    await symlink(outsidePath, sourcePath);
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById").mockResolvedValue(undefined);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", {
      channelId: "C_MATCH",
      files: [{ name: "source.txt", localPath: sourcePath }],
    });

    const triggerData = enqueueTaskById.mock.calls[0]?.[1] as { files: Array<{ localPath?: string }> };
    expect(triggerData.files[0]?.localPath).toBeUndefined();
  });

  it("uses the dispatched channel rather than a mismatched payload channel for source containment", async () => {
    const otherDir = "/tmp/slack-trigger-test/workspaces/channel-C_OTHER/attachments";
    const sourcePath = `${otherDir}/source.txt`;
    await mkdir(otherDir, { recursive: true });
    await writeFile(sourcePath, "other-channel-bytes");
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById").mockResolvedValue(undefined);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", {
      channelId: "C_OTHER",
      files: [{ name: "source.txt", localPath: sourcePath }],
    });

    const triggerData = enqueueTaskById.mock.calls[0]?.[1] as { files: Array<{ localPath?: string }> };
    expect(triggerData.files[0]?.localPath).toBeUndefined();
  });

  it("rejects source channel identifiers containing path traversal", async () => {
    const sourceDir = "/tmp/slack-trigger-test/workspaces/user-1/attachments";
    const sourcePath = `${sourceDir}/source.txt`;
    await mkdir(sourceDir, { recursive: true });
    await writeFile(sourcePath, "user-workspace-bytes");
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH/../user-1") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById").mockResolvedValue(undefined);

    await scheduler.dispatchSlackChannelMessage("C_MATCH/../user-1", {
      files: [{ name: "source.txt", localPath: sourcePath }],
    });

    const triggerData = enqueueTaskById.mock.calls[0]?.[1] as { files: Array<{ localPath?: string }> };
    expect(triggerData.files[0]?.localPath).toBeUndefined();
  });

  it("rejects a source channel workspace symlink to a sibling workspace", async () => {
    const outsideDir = "/tmp/slack-trigger-test/workspaces/user-2";
    const sourcePath = `${outsideDir}/source.txt`;
    await mkdir(outsideDir, { recursive: true });
    await writeFile(sourcePath, "outside-channel-bytes");
    await mkdir("/tmp/slack-trigger-test/workspaces", { recursive: true });
    await symlink(outsideDir, "/tmp/slack-trigger-test/workspaces/channel-C_MATCH");
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById").mockResolvedValue(undefined);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", {
      files: [{ name: "source.txt", localPath: sourcePath }],
    });

    const triggerData = enqueueTaskById.mock.calls[0]?.[1] as { files: Array<{ localPath?: string }> };
    expect(triggerData.files[0]?.localPath).toBeUndefined();
  });

  it("accepts the trusted nested workspace for a bound-agent channel", async () => {
    const sourceWorkspaceDir = "/tmp/slack-trigger-test/workspaces/agent-A/channel-C_MATCH";
    const sourcePath = `${sourceWorkspaceDir}/attachments/source.txt`;
    await mkdir(`${sourceWorkspaceDir}/attachments`, { recursive: true });
    await writeFile(sourcePath, "bound-agent-bytes");
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById").mockResolvedValue(undefined);

    await scheduler.dispatchSlackChannelMessage(
      "C_MATCH",
      { files: [{ name: "source.txt", localPath: sourcePath }] },
      { sourceWorkspaceDir },
    );

    const triggerData = enqueueTaskById.mock.calls[0]?.[1] as { files: Array<{ localPath?: string }> };
    await expect(readFile(triggerData.files[0]?.localPath ?? "", "utf8")).resolves.toBe("bound-agent-bytes");
  });

  it("rejects a symlinked automation trigger staging root", async () => {
    const sourceDir = "/tmp/slack-trigger-test/workspaces/channel-C_MATCH/attachments";
    const sourcePath = `${sourceDir}/source.txt`;
    const outsideDir = "/tmp/slack-trigger-test/outside-destination";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(sourcePath, "source-bytes");
    await symlink(outsideDir, "/tmp/slack-trigger-test/automation-trigger-files");
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById").mockResolvedValue(undefined);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", {
      files: [{ name: "source.txt", localPath: sourcePath }],
    });

    expect(enqueueTaskById).not.toHaveBeenCalled();
  });

  it("fails closed when the task creator is no longer a member of the Slack channel", async () => {
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const deps = makeDeps(db);
    deps.getSlack().isUserInChannel.mockResolvedValue(false);
    const scheduler = new TaskScheduler(deps as never);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", { messageTs: "1.2" });

    expect(executionParams).toHaveLength(0);
    expect(deps.getSlack().isUserInChannel).toHaveBeenCalledWith("C_MATCH", "U_CREATOR");
  });

  it("continues dispatching later matching tasks when an enqueue fails", async () => {
    const first = await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const second = await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const deps = makeDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const enqueueTaskByIdImpl = scheduler.enqueueTaskById.bind(scheduler);
    const enqueueTaskById = vi.spyOn(scheduler, "enqueueTaskById");
    enqueueTaskById.mockRejectedValueOnce(new Error("task no longer active")).mockImplementation(enqueueTaskByIdImpl);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", { messageTs: "1.2" });

    await vi.waitFor(() => expect(executionParams).toHaveLength(1));
    expect(enqueueTaskById).toHaveBeenNthCalledWith(1, first.id, { messageTs: "1.2" });
    expect(enqueueTaskById).toHaveBeenNthCalledWith(2, second.id, { messageTs: "1.2" });
    expect(deps.getSlack().isUserInChannel).toHaveBeenCalledOnce();
  });

  it("does not dispatch wrong-channel, paused, malformed, or non-Slack external workflows", async () => {
    await repo.add({ ...baseTask, steps: slackTrigger("C_OTHER") });
    await repo.add({ ...baseTask, status: "paused", steps: slackTrigger("C_MATCH") });
    await repo.add({ ...baseTask, steps: "not-json" });
    await repo.add({
      ...baseTask,
      steps: JSON.stringify([
        {
          id: "trigger",
          type: "trigger",
          label: "Slack channel message",
          icon: "slack",
          position: { x: 0, y: 0 },
          triggerConfig: { type: "slack_channel_message" },
        },
      ]),
    });
    await repo.add({
      ...baseTask,
      schedule_value: "canvas",
      steps: JSON.stringify([
        {
          id: "trigger",
          type: "trigger",
          label: "Canvas",
          icon: "canvas",
          position: { x: 0, y: 0 },
          triggerConfig: { type: "canvas" },
        },
      ]),
    });
    const scheduler = new TaskScheduler(makeDeps(db) as never);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", { messageTs: "1.2" });

    expect(executionParams).toHaveLength(0);
  });

  it("preserves an explicitly supplied null trigger payload", async () => {
    const task = await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);

    await scheduler.enqueueTaskById(task.id, null);

    await vi.waitFor(() => expect(executionParams).toHaveLength(1));
    expect(executionParams[0]?.triggerData).toBeNull();
  });
});
