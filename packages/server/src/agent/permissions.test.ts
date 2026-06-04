import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../test-utils";
import { createCanUseTool } from "./permissions";

const WORKSPACE = "/data/workspaces/test-user";
const CLAUDE_DIR = "/home/testuser/.claude";

function expectDeny(result: PermissionResult): asserts result is Extract<PermissionResult, { behavior: "deny" }> {
  expect(result.behavior).toBe("deny");
}

describe("createCanUseTool", () => {
  let canUseTool: ReturnType<typeof createCanUseTool> extends Promise<infer T>
    ? never
    : ReturnType<typeof createCanUseTool>;

  beforeEach(() => {
    const logger = createTestLogger();
    canUseTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR);
  });

  describe("tool allowlist", () => {
    it.each(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"])(
      "allows permitted tool: %s",
      async (tool) => {
        const result = await canUseTool(tool, {});
        expect(result.behavior).toBe("allow");
      },
    );

    it("denies unknown tool 'Task'", async () => {
      const result = await canUseTool("Task", {});
      expectDeny(result);
      expect(result.message).toContain("Task");
      expect(result.message).toContain("not allowed");
    });

    it("denies unknown tool 'NotebookEdit'", async () => {
      const result = await canUseTool("NotebookEdit", {});
      expectDeny(result);
      expect(result.message).toContain("NotebookEdit");
    });

    it("denies empty string tool name", async () => {
      const result = await canUseTool("", {});
      expectDeny(result);
      expect(result.message).toContain("not allowed");
    });

    it("allows MCP tool from sketch server", async () => {
      const result = await canUseTool("mcp__sketch__SendFileToChat", { file_path: "/some/path" });
      expect(result.behavior).toBe("allow");
    });

    it("allows MCP tool from any server", async () => {
      const result = await canUseTool("mcp__some-other-server__SomeTool", { param: "value" });
      expect(result.behavior).toBe("allow");
    });

    it("allows MCP tool with deeply nested server name", async () => {
      const result = await canUseTool("mcp__my-org__my-tool__action", {});
      expect(result.behavior).toBe("allow");
    });

    it("denies tool that contains mcp but does not start with mcp__", async () => {
      const result = await canUseTool("mcp_missing_prefix", {});
      expectDeny(result);
      expect(result.message).toContain("not allowed");
    });
  });

  describe("file tools — workspace access", () => {
    it("allows file_path inside workspace", async () => {
      const result = await canUseTool("Read", { file_path: `${WORKSPACE}/notes.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows path inside workspace (Glob uses path)", async () => {
      const result = await canUseTool("Glob", { path: `${WORKSPACE}/src` });
      expect(result.behavior).toBe("allow");
    });

    it("allows path inside workspace (Grep uses path)", async () => {
      const result = await canUseTool("Grep", { path: `${WORKSPACE}/src` });
      expect(result.behavior).toBe("allow");
    });

    it("denies file_path outside workspace", async () => {
      const result = await canUseTool("Read", { file_path: "/etc/passwd" });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies path traversal that resolves outside workspace", async () => {
      const result = await canUseTool("Write", { file_path: `${WORKSPACE}/../../etc/passwd` });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("allows when no path provided (defaults to workspace)", async () => {
      const result = await canUseTool("Grep", {});
      expect(result.behavior).toBe("allow");
    });

    it("allows subdirectory within workspace", async () => {
      const result = await canUseTool("Edit", { file_path: `${WORKSPACE}/src/deep/nested/file.ts` });
      expect(result.behavior).toBe("allow");
    });

    it("denies path that shares workspace prefix but is a sibling directory", async () => {
      const result = await canUseTool("Read", { file_path: `${WORKSPACE}-evil/secrets.txt` });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies Read for blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/image-without-extension`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Read", { file_path: blockedPath });

      expectDeny(result);
      expect(result.message).toContain("Use VisualAnalysis");
      expect(result.message).toContain(blockedPath);
    });

    it("resolves blocked attachment paths before comparing", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/image.png`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Read", { file_path: `${WORKSPACE}/attachments/../attachments/image.png` });

      expectDeny(result);
      expect(result.message).toContain("Use VisualAnalysis");
    });

    it("allows non-Read file tools for blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/image.png`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Grep", { path: blockedPath });

      expect(result.behavior).toBe("allow");
    });

    it("denies Bash commands that reference blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/image.png`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: `base64 "${blockedPath}"` });

      expectDeny(result);
      expect(result.message).toContain("Use VisualAnalysis");
      expect(result.message).toContain(blockedPath);
    });

    it("denies Bash commands that reference blocked attachment paths relative to the workspace", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/image.png`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: "cat ./attachments/image.png" });

      expectDeny(result);
      expect(result.message).toContain("Use VisualAnalysis");
    });

    it("denies Bash commands with relative globs that match blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/photo.png`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: "base64 attachments/*.png" });

      expectDeny(result);
      expect(result.message).toContain("Use VisualAnalysis");
    });

    it("denies Bash commands with absolute globs that match blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/photo.png`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: `cat ${WORKSPACE}/attachments/photo.*` });

      expectDeny(result);
      expect(result.message).toContain("Use VisualAnalysis");
    });

    it("allows Bash commands that do not reference blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${WORKSPACE}/attachments/image.png`;
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: "cat notes.txt" });

      expect(result.behavior).toBe("allow");
    });
  });

  describe("file tools — ~/.claude access", () => {
    it("allows Read tool with ~/.claude/skills/canvas/SKILL.md", async () => {
      const result = await canUseTool("Read", { file_path: `${CLAUDE_DIR}/skills/canvas/SKILL.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows Glob tool with ~/.claude/skills/ path", async () => {
      const result = await canUseTool("Glob", { path: `${CLAUDE_DIR}/skills/` });
      expect(result.behavior).toBe("allow");
    });

    it("allows Grep tool with ~/.claude path", async () => {
      const result = await canUseTool("Grep", { path: CLAUDE_DIR });
      expect(result.behavior).toBe("allow");
    });

    it("allows Write tool with ~/.claude/CLAUDE.md (org memory)", async () => {
      const result = await canUseTool("Write", { file_path: `${CLAUDE_DIR}/CLAUDE.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows Edit tool with ~/.claude/CLAUDE.md (org memory)", async () => {
      const result = await canUseTool("Edit", { file_path: `${CLAUDE_DIR}/CLAUDE.md` });
      expect(result.behavior).toBe("allow");
    });

    it("denies path that shares claude dir prefix but is a sibling directory", async () => {
      const result = await canUseTool("Read", { file_path: `${CLAUDE_DIR}-other/secrets.txt` });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });
  });

  describe("bash validation", () => {
    it("allows command with no absolute paths", async () => {
      const result = await canUseTool("Bash", { command: "ls" });
      expect(result.behavior).toBe("allow");
    });

    it("allows command like 'echo hello'", async () => {
      const result = await canUseTool("Bash", { command: "echo hello" });
      expect(result.behavior).toBe("allow");
    });

    it("allows command referencing workspace path", async () => {
      const result = await canUseTool("Bash", { command: `cat ${WORKSPACE}/notes.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows command referencing ~/.claude path", async () => {
      const result = await canUseTool("Bash", { command: `cat ${CLAUDE_DIR}/skills/canvas/SKILL.md` });
      expect(result.behavior).toBe("allow");
    });

    it("denies command referencing /etc/passwd", async () => {
      const result = await canUseTool("Bash", { command: "cat /etc/passwd" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it("denies command referencing /home/otheruser/", async () => {
      const result = await canUseTool("Bash", { command: "ls /home/otheruser/" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it("allows command with /dev/null", async () => {
      const result = await canUseTool("Bash", { command: "echo test > /dev/null" });
      expect(result.behavior).toBe("allow");
    });

    it("allows command with /tmp/ path", async () => {
      const result = await canUseTool("Bash", { command: "cat /tmp/somefile.txt" });
      expect(result.behavior).toBe("allow");
    });

    it("denies command with /data/ prefix outside workspace and claude dir", async () => {
      const result = await canUseTool("Bash", { command: "ls /data/shared" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it("allows command referencing workspace under /data/", async () => {
      const result = await canUseTool("Bash", { command: `cat ${WORKSPACE}/file.txt` });
      expect(result.behavior).toBe("allow");
    });

    it("allows brokered Canvas CLI commands with slashes in JSON values", async () => {
      const result = await canUseTool("Bash", {
        command:
          '$CANVAS_CLI direct-execute-action --component-key clickup-create-task --configured-props \'{"name":"Script / Quote | Parent","description":"A/B test"}\' --output json',
      });
      expect(result.behavior).toBe("allow");
    });

    it("temporarily allows brokered Canvas CLI commands with shell chaining", async () => {
      const result = await canUseTool("Bash", {
        command:
          '$CANVAS_CLI direct-execute-action --component-key clickup-create-task --configured-props \'{"name":"Script / Quote | Parent"}\' && cat /etc/passwd',
      });
      expect(result.behavior).toBe("allow");
    });
  });

  describe("edge cases", () => {
    it("allows WebSearch with no path validation", async () => {
      const result = await canUseTool("WebSearch", { query: "vitest testing" });
      expect(result.behavior).toBe("allow");
    });

    it("allows WebFetch with no path validation", async () => {
      const result = await canUseTool("WebFetch", { url: "https://example.com" });
      expect(result.behavior).toBe("allow");
    });

    it("allows Skill with no path validation", async () => {
      const result = await canUseTool("Skill", { name: "some-skill" });
      expect(result.behavior).toBe("allow");
    });
  });

  describe("agent allowlist", () => {
    it("allows tools that are in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { agentAllowedTools: ["Read", "Bash"] });

      const readResult = await agentTool("Read", { file_path: `${WORKSPACE}/notes.md` });
      expect(readResult.behavior).toBe("allow");

      const bashResult = await agentTool("Bash", { command: "ls" });
      expect(bashResult.behavior).toBe("allow");
    });

    it("denies built-in tools that are not in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { agentAllowedTools: ["Read"] });

      const result = await agentTool("Bash", { command: "ls" });
      expectDeny(result);
      expect(result.message).toContain("not in this agent's allowlist");
    });

    it("denies MCP tools that are not in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { agentAllowedTools: ["Read"] });

      const result = await agentTool("mcp__sketch__SendFileToChat", { file_path: `${WORKSPACE}/x` });
      expectDeny(result);
      expect(result.message).toContain("not in this agent's allowlist");
    });

    it("allows MCP tools that are in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, {
        agentAllowedTools: ["mcp__sketch__SendFileToChat"],
      });

      const result = await agentTool("mcp__sketch__SendFileToChat", { file_path: `${WORKSPACE}/x` });
      expect(result.behavior).toBe("allow");
    });

    it("treats an empty allowlist as 'block every tool' (admin opted out of all capabilities)", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { agentAllowedTools: [] });

      const builtIn = await agentTool("Read", { file_path: `${WORKSPACE}/notes.md` });
      expect(builtIn.behavior).toBe("deny");

      const mcp = await agentTool("mcp__sketch__SendMessageToUser", { message: "hi" });
      expect(mcp.behavior).toBe("deny");
    });

    it("treats null/undefined allowlist as 'no agent restriction' (legacy or non-agent run)", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(WORKSPACE, logger, CLAUDE_DIR, { agentAllowedTools: null });

      const builtIn = await agentTool("Read", { file_path: `${WORKSPACE}/notes.md` });
      expect(builtIn.behavior).toBe("allow");

      const mcp = await agentTool("mcp__sketch__SendMessageToUser", { message: "hi" });
      expect(mcp.behavior).toBe("allow");
    });
  });
});
