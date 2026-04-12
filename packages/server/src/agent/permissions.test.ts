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
  });

  describe("credential wrapper isolation (layer 3)", () => {
    const WRAPPER = "/tmp/sketch-int-canvas-run123.sh";

    describe("blocked — read-style Bash commands targeting wrapper files", () => {
      it.each([
        ["cat", `cat ${WRAPPER}`],
        ["head with flags", `head -n 5 ${WRAPPER}`],
        ["tail", `tail ${WRAPPER}`],
        ["less", `less ${WRAPPER}`],
        ["bat", `bat ${WRAPPER}`],
        ["xxd", `xxd ${WRAPPER}`],
        ["od", `od -c ${WRAPPER}`],
        ["hexdump", `hexdump -C ${WRAPPER}`],
        ["strings", `strings ${WRAPPER}`],
        ["file", `file ${WRAPPER}`],
        ["grep for secrets", `grep SECRET ${WRAPPER}`],
        ["awk", `awk '{print}' ${WRAPPER}`],
        ["sed", `sed -n 1p ${WRAPPER}`],
        ["cp to workspace (exfil)", `cp ${WRAPPER} ${WORKSPACE}/stolen.sh`],
        ["mv to workspace (exfil)", `mv ${WRAPPER} ${WORKSPACE}/stolen.sh`],
        ["cat with input redirection", `cat < ${WRAPPER}`],
        ["base64 encode", `base64 ${WRAPPER}`],
        ["vi open", `vi ${WRAPPER}`],
        ["chained after &&", `echo foo && cat ${WRAPPER}`],
        ["chained after ||", `false || cat ${WRAPPER}`],
        ["chained after ;", `echo foo; cat ${WRAPPER}`],
        ["bash -c wrapping", `bash -c "cat ${WRAPPER}"`],
      ])("denies: %s", async (_name, command) => {
        const result = await canUseTool("Bash", { command });
        expectDeny(result);
        expect(result.message).toContain("cannot read integration credential files");
      });
    });

    describe("allowed — execution with downstream output truncation (the key fix)", () => {
      it("allows wrapper execution piped to head for output truncation", async () => {
        const result = await canUseTool("Bash", { command: `${WRAPPER} action list | head -c 2000` });
        expect(result.behavior).toBe("allow");
      });

      it("allows wrapper execution piped to tail", async () => {
        const result = await canUseTool("Bash", { command: `${WRAPPER} action list | tail -n 20` });
        expect(result.behavior).toBe("allow");
      });

      it("allows wrapper execution piped to jq", async () => {
        const result = await canUseTool("Bash", { command: `${WRAPPER} action list | jq .result` });
        expect(result.behavior).toBe("allow");
      });

      it("allows wrapper execution piped to grep (filter wrapper OUTPUT, not read wrapper FILE)", async () => {
        const result = await canUseTool("Bash", { command: `${WRAPPER} action list | grep canvas` });
        expect(result.behavior).toBe("allow");
      });

      it("allows direct wrapper execution without any read command", async () => {
        const result = await canUseTool("Bash", { command: `${WRAPPER} action list` });
        expect(result.behavior).toBe("allow");
      });

      it("allows sh invocation of the wrapper (sh is not a read command)", async () => {
        const result = await canUseTool("Bash", { command: `sh ${WRAPPER} action list` });
        expect(result.behavior).toBe("allow");
      });
    });

    describe("allowed — unrelated commands that happen to contain 'sketch-int-' or a read command", () => {
      it("allows env | grep CANVAS (grep, but no /sketch-int- path)", async () => {
        const result = await canUseTool("Bash", { command: "env | grep CANVAS" });
        expect(result.behavior).toBe("allow");
      });

      it("allows cat of a non-wrapper /tmp file", async () => {
        const result = await canUseTool("Bash", { command: "cat /tmp/other.txt" });
        expect(result.behavior).toBe("allow");
      });

      it("allows head of a workspace file", async () => {
        const result = await canUseTool("Bash", { command: `head ${WORKSPACE}/notes.md` });
        expect(result.behavior).toBe("allow");
      });
    });

    describe("layer 2 still covers file-tool reads of wrapper paths (no separate layer 3 needed for file tools)", () => {
      it("denies Read tool with wrapper path (via layer 2 workspace boundary, not layer 3)", async () => {
        const result = await canUseTool("Read", { file_path: WRAPPER });
        expectDeny(result);
        expect(result.message).toContain("outside your workspace");
      });

      it("denies Glob with wrapper path", async () => {
        const result = await canUseTool("Glob", { path: WRAPPER });
        expectDeny(result);
        expect(result.message).toContain("outside your workspace");
      });

      it("denies Grep with wrapper path", async () => {
        const result = await canUseTool("Grep", { path: WRAPPER });
        expectDeny(result);
        expect(result.message).toContain("outside your workspace");
      });
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
});
