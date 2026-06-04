import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { SketchMcpDeps, ToolResult } from "./types";

const localRunCommandDescription = `Run a shell command on the user's paired local Mac through Sketch Local.

Use this when the user explicitly asks to inspect or operate on their local machine. The command runs on the paired Mac with that user's local permissions. stdout and stderr are returned to this run only; Sketch stores audit metadata, not command output.`;

const localRunCommandSchema = {
  command: z.string().min(1).describe("Shell command to run on the paired Mac."),
  cwd: z.string().optional().describe("Working directory on the Mac. Omit to use the Mac app's default directory."),
  deviceId: z.string().optional().describe("Specific local device ID. Omit to use the most recently connected Mac."),
  timeoutMs: z.number().int().min(1000).max(300000).optional().describe("Command timeout in milliseconds."),
  maxOutputBytes: z.number().int().min(1024).max(1000000).optional().describe("Maximum stdout/stderr bytes to return."),
};

type LocalRunCommandArgs = z.infer<z.ZodObject<typeof localRunCommandSchema>>;

export async function handleLocalRunCommand(args: LocalRunCommandArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  if (!deps.localDeviceInvoker || !deps.currentUserId) {
    return { content: [{ type: "text", text: "Local command execution is not available." }] };
  }

  try {
    const result = await deps.localDeviceInvoker.invoke(deps.currentUserId, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              deviceId: result.deviceId,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              durationMs: result.durationMs,
              stdout: result.stdout,
              stderr: result.stderr,
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
              errorMessage: result.errorMessage ?? null,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Local command failed";
    return { content: [{ type: "text", text: `Local command failed: ${message}` }] };
  }
}

export function createLocalRunCommandTool(deps: SketchMcpDeps) {
  return tool("local_run_command", localRunCommandDescription, localRunCommandSchema, (args) =>
    handleLocalRunCommand(args, deps),
  );
}
