import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { LocalClaudeSessionService } from "../../local-devices/claude-sessions";
import type { SketchMcpDeps, ToolResult } from "./types";

const localClaudeSessionDescription = `Manage Claude Code running in a Sketch-managed tmux session on the user's paired local Mac.

Use this when the user asks Sketch to delegate coding work to local Claude Code. Create starts Claude Code with bypass permissions and an initial prompt. Do not poll continuously; capture when an event arrives, before sending follow-up input, or when the user asks for current state.`;

const localClaudeSessionSchema = {
  action: z.enum(["create", "list", "capture", "send_text", "send_key", "interrupt", "kill", "reconcile"]),
  sessionId: z.string().optional().describe("Local Claude session ID. Required except for create and list."),
  prompt: z.string().optional().describe("Initial coding task for create."),
  title: z.string().optional().describe("Optional title for create."),
  cwd: z.string().optional().describe("Local working directory on the paired Mac for create."),
  deviceId: z
    .string()
    .optional()
    .describe("Specific paired local Mac device ID. Omit to use the most recently connected Mac."),
  text: z.string().optional().describe("Text to send for send_text."),
  submit: z.boolean().optional().describe("Whether send_text should press Enter after typing. Defaults to true."),
  key: z.string().optional().describe("Key name for send_key, e.g. Enter, Escape, C-c, Up, Down."),
  lines: z.number().int().min(1).max(1000).optional().describe("Number of scrollback lines to capture."),
};

type LocalClaudeSessionArgs = z.infer<z.ZodObject<typeof localClaudeSessionSchema>>;

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function requireService(
  deps: SketchMcpDeps,
): { service: LocalClaudeSessionService; currentUserId: string } | { error: ToolResult } {
  if (!deps.localClaudeSessionService || !deps.currentUserId) {
    return { error: { content: [{ type: "text", text: "Local Claude sessions are not available." }] } };
  }
  return { service: deps.localClaudeSessionService, currentUserId: deps.currentUserId };
}

function requireSessionId(args: LocalClaudeSessionArgs): string {
  if (!args.sessionId) throw new Error("sessionId is required for this action.");
  return args.sessionId;
}

export async function handleLocalClaudeSession(args: LocalClaudeSessionArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  const resolved = requireService(deps);
  if ("error" in resolved) return resolved.error;
  const { service, currentUserId } = resolved;

  try {
    if (args.action === "create") {
      if (!args.prompt?.trim()) throw new Error("prompt is required for create.");
      const result = await service.create({
        userId: currentUserId,
        prompt: args.prompt,
        title: args.title,
        cwd: args.cwd,
        deviceId: args.deviceId,
        origin: {
          platform: deps.taskContext?.platform,
          contextType: deps.taskContext?.contextType,
          deliveryTarget: deps.taskContext?.deliveryTarget,
          threadTs: deps.taskContext?.threadTs ?? deps.originThreadTs ?? null,
          workspaceKey: deps.workspaceKey,
          workspaceDir: deps.workspaceDir,
          activeQueueKey: deps.activeQueueKey,
          conversationId: deps.conversationContext?.conversationId ?? null,
          providerThreadId: deps.conversationContext?.providerThreadId ?? null,
          agentInstructions: deps.agentInstructions ?? null,
          agentAllowedTools: deps.agentAllowedTools ?? null,
          orgContextEnabled: deps.originOrgContextEnabled,
        },
      });
      return jsonResult({
        session: result.session,
        launch: {
          exitCode: result.launch.exitCode,
          timedOut: result.launch.timedOut,
          errorMessage: result.launch.errorMessage,
          stderr: result.launch.stderr,
        },
      });
    }

    if (args.action === "list") {
      return jsonResult({ sessions: await service.list(currentUserId) });
    }

    if (args.action === "capture") {
      const result = await service.capture(currentUserId, requireSessionId(args), args.lines);
      return jsonResult({ session: result.session, text: result.text });
    }

    if (args.action === "send_text") {
      if (args.text === undefined) throw new Error("text is required for send_text.");
      const result = await service.sendText(currentUserId, requireSessionId(args), args.text, args.submit ?? true);
      return jsonResult({ session: result.session, exitCode: result.result.exitCode });
    }

    if (args.action === "send_key") {
      if (!args.key) throw new Error("key is required for send_key.");
      const result = await service.sendKey(currentUserId, requireSessionId(args), args.key);
      return jsonResult({ session: result.session, exitCode: result.result.exitCode });
    }

    if (args.action === "interrupt") {
      const result = await service.interrupt(currentUserId, requireSessionId(args));
      return jsonResult({ session: result.session, exitCode: result.result.exitCode });
    }

    if (args.action === "kill") {
      const result = await service.kill(currentUserId, requireSessionId(args));
      return jsonResult({ session: result.session, exitCode: result.result.exitCode });
    }

    if (args.action === "reconcile") {
      return jsonResult({ session: await service.reconcile(currentUserId, requireSessionId(args)) });
    }

    return { content: [{ type: "text", text: "Unsupported action." }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Local Claude session action failed";
    return { content: [{ type: "text", text: `Local Claude session failed: ${message}` }] };
  }
}

export function createLocalClaudeSessionTool(deps: SketchMcpDeps) {
  return tool("local_claude_session", localClaudeSessionDescription, localClaudeSessionSchema, (args) =>
    handleLocalClaudeSession(args, deps),
  );
}
