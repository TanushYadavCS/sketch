/**
 * Unified automation runtime.
 *
 * Every automation (simple or multi-step) is executed through this single code path.
 * The scheduler calls executeAutomation() for all tasks — no branching.
 *
 * Steps are executed in array order (edges are metadata for the UI, ignored in Phase 1).
 * Step content (prompts, scripts) is loaded from automation_step_content at execution time.
 * Credentials are resolved at execution time via findIntegrationProvider (org-level) +
 * creator's email (user scoping).
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { buildPlatformFormattingLines } from "../agent/prompt";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import type { StepOutput, WorkflowStep } from "./types";

export interface ExecuteAutomationParams {
  task: ScheduledTaskRow;
  triggerData?: unknown;
  db: Kysely<DB>;
  logger: Logger;
  config: { DATA_DIR: string; BASE_URL?: string; PORT: number; CLAUDE_CONFIG_DIR: string };
  runsRepo: ReturnType<typeof createAutomationRunsRepository>;
  stepContentRepo: ReturnType<typeof createAutomationStepContentRepository>;
  findIntegrationProvider: () => Promise<{ type: string; credentials: string } | null>;
  userRepo: { findById: (id: string) => Promise<{ email: string | null } | undefined> };
  sendMessage?: (text: string) => Promise<void>;
}

export async function executeAutomation(params: ExecuteAutomationParams): Promise<{ runId: string; status: string }> {
  const { task, triggerData, logger, runsRepo, stepContentRepo, sendMessage } = params;

  // 1. Verify creator exists
  const creatorId = task.created_by;
  let creatorEmail: string | null = null;
  if (creatorId) {
    const creator = await params.userRepo.findById(creatorId);
    if (!creator) {
      logger.error({ taskId: task.id, creatorId }, "Automation: creator no longer exists");
      const runId = await runsRepo.create({ taskId: task.id, triggerData });
      await runsRepo.update(runId, {
        status: "failed",
        errorMessage: "Creator no longer exists",
        completedAt: new Date().toISOString(),
      });
      if (sendMessage) {
        await sendMessage(`Automation '${task.title ?? task.prompt}' failed: Creator no longer exists`);
      }
      return { runId, status: "failed" };
    }
    creatorEmail = creator.email;
  }

  // 2. Parse steps (legacy tasks without steps get a single agent step)
  let steps: WorkflowStep[];
  if (task.steps) {
    steps = JSON.parse(task.steps);
  } else {
    steps = [
      { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
      { id: "step1", type: "agent", label: task.prompt, icon: "sketch-ai", position: { x: 0, y: 100 } },
    ];
  }

  // 3. Load step content
  const contentRows = await stepContentRepo.getByTask(task.id);
  const contentMap = new Map(contentRows.map((r) => [r.step_id, r]));

  // 4. Create run record
  const runId = await runsRepo.create({ taskId: task.id, triggerData });

  logger.info(
    {
      taskId: task.id,
      runId,
      title: task.title,
      stepCount: steps.length,
    },
    "Automation: execution started",
  );

  // 5. Execute steps in array order
  const stepOutputs: Record<string, StepOutput> = {};
  let previousOutput: unknown = triggerData ?? null;
  let failed = false;

  for (const step of steps) {
    if (step.type === "trigger") continue;

    const content = contentMap.get(step.id);
    const startTime = Date.now();

    logger.info(
      { taskId: task.id, runId, stepId: step.id, stepType: step.type, stepLabel: step.label },
      "Automation: step starting",
    );

    try {
      let output: unknown;

      if (step.type === "action") {
        if (!content || content.content_type !== "script") {
          throw new Error(`Action step "${step.label}" has no script`);
        }
        output = await executeActionStep({
          script: content.content,
          step,
          input: previousOutput,
          runId,
          logger,
          config: params.config,
          creatorEmail,
          workspaceDir: resolveWorkspaceDir(params.config.DATA_DIR, task),
          findIntegrationProvider: params.findIntegrationProvider,
        });
      } else if (step.type === "agent") {
        // Content from automation_step_content, fallback to task.prompt for legacy tasks
        const prompt = content?.content ?? (!task.steps ? task.prompt : null);
        if (!prompt) {
          throw new Error(`Agent step "${step.label}" has no prompt`);
        }
        output = await executeAgentStep({
          prompt,
          step,
          input: previousOutput,
          logger,
          workspaceDir: resolveWorkspaceDir(params.config.DATA_DIR, task),
          // output_platform lets a workflow deliver to a different channel than
          // its trigger context; fall back to the task's own platform otherwise.
          outputPlatform: (task.output_platform ?? task.platform) as "slack" | "whatsapp",
        });
      }

      const durationMs = Date.now() - startTime;
      stepOutputs[step.id] = { output, status: "completed", duration_ms: durationMs };
      previousOutput = output;

      logger.info({ taskId: task.id, runId, stepId: step.id, durationMs }, "Automation: step completed");

      await runsRepo.update(runId, { stepOutputs });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const error = err instanceof Error ? err : new Error(String(err));
      stepOutputs[step.id] = {
        output: null,
        status: "failed",
        duration_ms: durationMs,
        error: { message: error.message, stack: error.stack },
      };

      // Mark remaining steps as skipped
      let foundFailed = false;
      for (const s of steps) {
        if (s.id === step.id) {
          foundFailed = true;
          continue;
        }
        if (foundFailed && s.type !== "trigger" && !stepOutputs[s.id]) {
          stepOutputs[s.id] = { output: null, status: "skipped", duration_ms: 0 };
        }
      }

      await runsRepo.update(runId, {
        status: "failed",
        stepOutputs,
        completedAt: new Date().toISOString(),
        errorMessage: `Step "${step.label}" failed: ${error.message}`,
      });

      failed = true;
      logger.error(
        { err, taskId: task.id, runId, stepId: step.id, stepLabel: step.label, durationMs },
        "Automation: step failed",
      );

      // Send failure notification
      if (sendMessage) {
        await sendMessage(`Automation '${task.title ?? task.prompt}' failed at step '${step.label}': ${error.message}`);
      }
      break;
    }
  }

  // 6. On success: deliver final output + write context file
  if (!failed) {
    await runsRepo.update(runId, {
      status: "completed",
      stepOutputs,
      completedAt: new Date().toISOString(),
    });

    logger.info({ taskId: task.id, runId }, "Automation: execution completed");

    // Deliver final step's output
    if (sendMessage) {
      const executionSteps = steps.filter((s) => s.type !== "trigger");
      const lastStep = executionSteps[executionSteps.length - 1];
      const lastOutput = lastStep ? stepOutputs[lastStep.id]?.output : null;
      if (lastOutput != null) {
        const message = typeof lastOutput === "string" ? lastOutput : JSON.stringify(lastOutput, null, 2);
        await sendMessage(message);
      }
    }
  }

  // 7. Write context file
  const workspaceDir = resolveWorkspaceDir(params.config.DATA_DIR, task);
  await writeAutomationContext({
    workspaceDir,
    taskId: task.id,
    runId,
    title: task.title ?? task.prompt,
    triggerSummary: triggerData ? JSON.stringify(triggerData).slice(0, 200) : "Manual/scheduled trigger",
    steps: steps
      .filter((s) => s.type !== "trigger")
      .map((s) => ({
        label: s.label,
        status: stepOutputs[s.id]?.status ?? "skipped",
        duration_ms: stepOutputs[s.id]?.duration_ms ?? 0,
        outputSummary:
          stepOutputs[s.id]?.output != null ? JSON.stringify(stepOutputs[s.id].output).slice(0, 200) : undefined,
      })),
    logger,
  });

  return { runId, status: failed ? "failed" : "completed" };
}

function resolveWorkspaceDir(dataDir: string, task: ScheduledTaskRow): string {
  if (task.context_type === "channel") {
    return join(dataDir, "workspaces", `channel-${task.delivery_target}`);
  }
  if (task.context_type === "group") {
    const groupId = task.delivery_target.replace("@g.us", "");
    return join(dataDir, "workspaces", `wa-group-${groupId}`);
  }
  const userId = task.created_by ?? task.delivery_target;
  return join(dataDir, "workspaces", userId);
}

// --- Action step: child process ---

interface ActionStepParams {
  script: string;
  step: WorkflowStep;
  input: unknown;
  runId: string;
  logger: Logger;
  config: ExecuteAutomationParams["config"];
  creatorEmail: string | null;
  workspaceDir: string;
  findIntegrationProvider: () => Promise<{ type: string; credentials: string } | null>;
}

async function executeActionStep(params: ActionStepParams): Promise<unknown> {
  const { script, step, input, runId, logger, creatorEmail, workspaceDir, findIntegrationProvider } = params;

  // Resolve integration env vars for the action step child process.
  //
  // INTEGRATION_CLI is the generic contract that action-step scripts rely on:
  // scripts invoke `node $INTEGRATION_CLI <subcommand>` without knowing which
  // provider is configured. Today only the Canvas provider is wired here; when
  // a second provider lands, this block should branch to resolve the correct
  // CLI path per provider type.
  const integrationEnv: Record<string, string> = {};
  const provider = await findIntegrationProvider();
  if (provider?.type === "canvas") {
    const creds = JSON.parse(provider.credentials);
    if (creds.apiKey) integrationEnv.CANVAS_API_KEY_MCP = creds.apiKey;
    if (creatorEmail) integrationEnv.CANVAS_USER_EMAIL = creatorEmail;
    integrationEnv.INTEGRATION_CLI = join(params.config.CLAUDE_CONFIG_DIR, "skills", "canvas", "canvas-cli.js");
  }

  const tempFile = join(tmpdir(), `sketch-auto-${runId}-${step.id}.js`);
  const wrappedScript = `
const input = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
async function main() {
  ${script}
}
main().then(output => {
  process.stdout.write(JSON.stringify(output ?? null));
}).catch(err => {
  process.stderr.write(JSON.stringify({ message: err.message, stack: err.stack }));
  process.exit(1);
});
`;

  await writeFile(tempFile, wrappedScript, "utf-8");

  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timeoutMs = (step.timeout ?? 1800) * 1000;
      const child = spawn("node", [tempFile], {
        timeout: timeoutMs,
        env: {
          PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
          NODE_NO_WARNINGS: "1",
          ...integrationEnv,
        },
        cwd: workspaceDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdin.write(JSON.stringify(input ?? null));
      child.stdin.end();

      child.on("close", (code) => {
        logger.info(
          { stepId: step.id, exitCode: code, stdoutLen: stdout.length, stderrLen: stderr.length },
          "Automation action: child process exited",
        );
        if (code !== 0) {
          let errorMsg: string;
          try {
            const parsed = JSON.parse(stderr);
            errorMsg = parsed.message || stderr;
          } catch {
            errorMsg = stderr || `Process exited with code ${code}`;
          }
          reject(new Error(errorMsg));
        } else {
          try {
            resolve(stdout ? JSON.parse(stdout) : null);
          } catch {
            resolve(stdout || null);
          }
        }
      });

      child.on("error", (err) => {
        reject(err);
      });
    });
  } finally {
    await rm(tempFile, { force: true }).catch(() => {});
  }
}

// --- Agent step: light mode ---

interface AgentStepParams {
  prompt: string;
  step: WorkflowStep;
  input: unknown;
  logger: Logger;
  workspaceDir: string;
  outputPlatform: "slack" | "whatsapp";
}

async function executeAgentStep(params: AgentStepParams): Promise<unknown> {
  const { prompt, step, input, logger, workspaceDir, outputPlatform } = params;

  if (step.agentMode === "sketch") {
    logger.warn({ stepId: step.id }, "Automation agent: sketch mode not implemented, falling back to light mode");
  }

  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const userMessage = `${prompt}\n\nInput:\n${JSON.stringify(input, null, 2)}`;

  // Capture stderr from the spawned Claude Code subprocess so failures produce
  // an actionable error message instead of an opaque "exited with code 1".
  const stderrChunks: string[] = [];

  // Model: only override if the step explicitly specifies one. Otherwise let
  // the CLI fall back to ANTHROPIC_MODEL from the environment, which is set by
  // applyLlmEnvFromSettings at startup and carries the correct ID for whichever
  // backend (Anthropic / Bedrock / Vertex) is configured. Hardcoding an
  // Anthropic-format model ID here breaks every non-Anthropic backend.
  const modelOverride = step.agentModel;

  // System prompt: generic workflow-step directive + channel-native formatting
  // rules so the final step of an automation renders correctly wherever the
  // output is delivered (Slack mrkdwn vs WhatsApp conventions). Uses the same
  // helper the main chat agent uses via buildSystemContext — any tweaks to
  // platform formatting rules land in both paths at once.
  const systemPromptLines = [
    "You are a workflow step in an automation. Complete the task described below and return a concise result. Do not ask questions — work with what you have.",
    "",
    "The text you return is delivered directly to the user's chat channel. Format it for that channel:",
    "",
    ...buildPlatformFormattingLines(outputPlatform),
  ];

  const run = query({
    prompt: userMessage,
    options: {
      maxTurns: 10,
      ...(modelOverride ? { model: modelOverride } : {}),
      cwd: workspaceDir,
      systemPrompt: systemPromptLines.join("\n"),
      // bypassPermissions + empty settingSources: the agent step runs
      // non-interactively, with no user settings / skills / MCP servers loaded,
      // and no permission prompts to block tool calls.
      permissionMode: "bypassPermissions" as const,
      settingSources: [],
      stderr: (chunk: string) => {
        stderrChunks.push(chunk);
      },
    },
  });

  let lastText = "";
  try {
    for await (const message of run) {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "assistant" &&
        "message" in message
      ) {
        const msg = message.message as { content?: Array<{ type: string; text?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              lastText = block.text;
            }
          }
        }
      }
    }
  } catch (err) {
    const stderrText = stderrChunks.join("").slice(0, 2000);
    logger.error({ err, stepId: step.id, stderrText }, "Automation agent: step failed (Claude Code subprocess error)");
    const baseMsg = err instanceof Error ? err.message : String(err);
    throw new Error(stderrText ? `${baseMsg}\nstderr: ${stderrText}` : baseMsg);
  }

  logger.info(
    { stepId: step.id, responseLength: lastText.length, stderrLen: stderrChunks.join("").length },
    "Automation agent: step completed",
  );

  // Return the raw assistant text, not a wrapper object. The delivery path
  // (executeAutomation) sends strings as-is and stringifies objects — so the
  // raw string both renders cleanly in Slack/WhatsApp and makes the run log
  // readable (no `{ "response": "..." }` wrapper in stored step_outputs).
  return lastText;
}

// --- Context file writer ---

async function writeAutomationContext(params: {
  workspaceDir: string;
  taskId: string;
  runId: string;
  title: string;
  triggerSummary: string;
  steps: Array<{ label: string; status: string; duration_ms: number; outputSummary?: string }>;
  logger: Logger;
}): Promise<void> {
  const contextDir = join(params.workspaceDir, ".workflow-context");
  try {
    await mkdir(contextDir, { recursive: true });
  } catch {
    params.logger.warn({ contextDir }, "Automation: could not create context directory");
    return;
  }

  const statusIcon = (s: string) => (s === "completed" ? "\u2713" : s === "failed" ? "\u2717" : "\u2014");

  const lines = [
    `# Automation: ${params.title}`,
    `**Run:** ${new Date().toISOString()}`,
    `**Trigger:** ${params.triggerSummary}`,
    "",
    "## Steps Executed",
  ];

  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i];
    const duration = (step.duration_ms / 1000).toFixed(1);
    lines.push(`${i + 1}. ${statusIcon(step.status)} ${step.label} (${duration}s)`);
    if (step.outputSummary) {
      lines.push(`   ${step.outputSummary}`);
    }
  }

  const fileName = `${params.taskId}-${params.runId}.md`;
  await writeFile(join(contextDir, fileName), lines.join("\n"), "utf-8");

  // Rotate: keep last 5
  const files = await readdir(contextDir);
  const taskFiles = files.filter((f) => f.startsWith(params.taskId)).sort();
  if (taskFiles.length > 5) {
    const toDelete = taskFiles.slice(0, taskFiles.length - 5);
    for (const file of toDelete) {
      await rm(join(contextDir, file), { force: true }).catch(() => {});
    }
  }
}
