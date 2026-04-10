import { describe, expect, it } from "vitest";
import { buildToolProgressLine, dedup } from "./tool-progress";

describe("buildToolProgressLine", () => {
  describe("emoji and primary arg per tool", () => {
    it("Read shows 📖 emoji and file_path value", () => {
      expect(buildToolProgressLine("Read", { file_path: "src/agent/runner.ts" })).toBe(
        '📖 Read: "src/agent/runner.ts"',
      );
    });

    it("Write shows ✍️ emoji and file_path value", () => {
      expect(buildToolProgressLine("Write", { file_path: "src/output.ts" })).toBe('✍️ Write: "src/output.ts"');
    });

    it("Edit shows 🔧 emoji and file_path value", () => {
      expect(buildToolProgressLine("Edit", { file_path: "src/config.ts" })).toBe('🔧 Edit: "src/config.ts"');
    });

    it("Bash shows 💻 emoji and command value", () => {
      expect(buildToolProgressLine("Bash", { command: "pnpm test" })).toBe('💻 Bash: "pnpm test"');
    });

    it("Glob shows 📂 emoji and pattern value", () => {
      expect(buildToolProgressLine("Glob", { pattern: "**/*.ts" })).toBe('📂 Glob: "**/*.ts"');
    });

    it("Grep shows 🔎 emoji and pattern value", () => {
      expect(buildToolProgressLine("Grep", { pattern: "runAgent" })).toBe('🔎 Grep: "runAgent"');
    });

    it("Skill shows 📚 emoji and skill value", () => {
      expect(buildToolProgressLine("Skill", { skill: "commit" })).toBe('📚 Skill: "commit"');
    });

    it("SendFileToChat shows 📎 emoji and file_path value", () => {
      expect(buildToolProgressLine("SendFileToChat", { file_path: "report.pdf" })).toBe(
        '📎 SendFileToChat: "report.pdf"',
      );
    });

    it("ManageScheduledTasks shows ⏰ emoji and action value", () => {
      expect(buildToolProgressLine("ManageScheduledTasks", { action: "list" })).toBe('⏰ ManageScheduledTasks: "list"');
    });

    it("SearchEntities shows 🔍 emoji and queries value", () => {
      expect(buildToolProgressLine("SearchEntities", { queries: ["foo", "bar"] })).toBe(
        '🔍 SearchEntities: "["foo","bar"]"',
      );
    });

    it("GetEntityContext shows 📊 emoji with ellipsis (no primary arg in map)", () => {
      expect(buildToolProgressLine("GetEntityContext", { entity_id: "123" })).toBe("📊 GetEntityContext...");
    });

    it("unknown MCP tool shows ⚙️ fallback emoji with ellipsis", () => {
      expect(buildToolProgressLine("SomeMcpTool", { anything: "value" })).toBe("⚙️ SomeMcpTool...");
    });
  });

  describe("arg truncation", () => {
    it("primary arg truncated to 40 chars with '...' suffix when longer than 40 chars", () => {
      const longPath = "a".repeat(41);
      const result = buildToolProgressLine("Read", { file_path: longPath });
      expect(result).toBe(`📖 Read: "${"a".repeat(40)}..."`);
    });

    it("primary arg exactly 40 chars is NOT truncated", () => {
      const exactPath = "a".repeat(40);
      const result = buildToolProgressLine("Read", { file_path: exactPath });
      expect(result).toBe(`📖 Read: "${"a".repeat(40)}"`);
    });

    it("primary arg of 41 chars IS truncated", () => {
      const path41 = "b".repeat(41);
      const result = buildToolProgressLine("Bash", { command: path41 });
      expect(result).toBe(`💻 Bash: "${"b".repeat(40)}..."`);
    });
  });

  describe("missing or empty primary arg", () => {
    it("primary arg key present but value is undefined shows tool name with ellipsis", () => {
      expect(buildToolProgressLine("Read", { file_path: undefined })).toBe("📖 Read...");
    });

    it("primary arg key present but value is null shows tool name with ellipsis", () => {
      expect(buildToolProgressLine("Read", { file_path: null })).toBe("📖 Read...");
    });

    it("empty input object shows tool name with ellipsis", () => {
      expect(buildToolProgressLine("Glob", {})).toBe("📂 Glob...");
    });
  });
});

describe("dedup", () => {
  it("identical consecutive lines get counter: last entry updated to include (x2)", () => {
    const lines = ['📖 Read: "config.ts"', '📖 Read: "config.ts"'];
    const result = dedup(lines);
    expect(result).toEqual(['📖 Read: "config.ts" (x2)']);
  });

  it("three identical consecutive lines: counter shows (x3)", () => {
    const lines = ['📖 Read: "config.ts"', '📖 Read: "config.ts"', '📖 Read: "config.ts"'];
    const result = dedup(lines);
    expect(result).toEqual(['📖 Read: "config.ts" (x3)']);
  });

  it("different consecutive lines are not collapsed", () => {
    const lines = ['📖 Read: "a.ts"', '🔧 Edit: "b.ts"'];
    const result = dedup(lines);
    expect(result).toEqual(['📖 Read: "a.ts"', '🔧 Edit: "b.ts"']);
  });

  it("single line array returns unchanged", () => {
    const lines = ['📖 Read: "config.ts"'];
    const result = dedup(lines);
    expect(result).toEqual(['📖 Read: "config.ts"']);
  });

  it("empty array returns unchanged", () => {
    const result = dedup([]);
    expect(result).toEqual([]);
  });

  it("only the LAST entry is checked for dedup (earlier duplicates don't matter)", () => {
    const lines = ['📖 Read: "a.ts"', '🔧 Edit: "b.ts"', '📖 Read: "a.ts"', '📖 Read: "a.ts"'];
    const result = dedup(lines);
    expect(result).toEqual(['📖 Read: "a.ts"', '🔧 Edit: "b.ts"', '📖 Read: "a.ts" (x2)']);
  });

  it("line that already has a counter gets incremented: (x2) becomes (x3)", () => {
    const lines = ['📖 Read: "config.ts" (x2)', '📖 Read: "config.ts"'];
    const result = dedup(lines);
    expect(result).toEqual(['📖 Read: "config.ts" (x3)']);
  });
});
