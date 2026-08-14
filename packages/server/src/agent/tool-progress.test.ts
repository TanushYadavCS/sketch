import { describe, expect, it } from "vitest";
import type { ProgressDisplaySettings } from "../progress-settings";
import type { ProgressEvent } from "./runner";
import {
  createProgressRenderer,
  createWebProgressData,
  createWebProgressItem,
  getProgressTransportStrategy,
} from "./tool-progress";

function renderEvents(settings: ProgressDisplaySettings, events: ProgressEvent[]) {
  const renderer = createProgressRenderer(settings);
  for (const event of events) {
    renderer.renderEvent(event);
  }
  return { lines: renderer.getLines() };
}

describe("createProgressRenderer", () => {
  it("renders technical mode with clipped primary args", () => {
    const longPath = `src/${"very-long-folder-name/".repeat(5)}index.ts`;
    const { lines } = renderEvents({ toolProgress: "technical", reasoningText: false }, [
      { kind: "tool_use", toolName: "Read", input: { file_path: longPath } },
    ]);

    expect(lines).toEqual([`📖 Read: "${longPath.slice(0, 40)}..."`]);
  });

  it("suppresses intermediate text when reasoning text is off", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "intermediate_text", text: "Thinking..." },
    ]);
    expect(lines).toEqual([]);
  });

  it("renders reasoning-only updates when tool progress is off", () => {
    const { lines } = renderEvents({ toolProgress: "off", reasoningText: true }, [
      { kind: "intermediate_text", text: "Checking config" },
    ]);
    expect(lines).toEqual(["💬 Checking config"]);
  });

  it("renders nothing when both tool progress and reasoning text are off", () => {
    const { lines } = renderEvents({ toolProgress: "off", reasoningText: false }, [
      { kind: "intermediate_text", text: "Checking config" },
      { kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } },
    ]);
    expect(lines).toEqual([]);
  });

  it("renders friendly file operations with targets", () => {
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "Read", input: { file_path: "src/index.ts" } },
      ]).lines,
    ).toEqual(['📖 Reading "src/index.ts"']);
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "Write", input: { file_path: "notes.md" } },
      ]).lines,
    ).toEqual(['✍️ Creating "notes.md"']);
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "Edit", input: { file_path: "src/index.ts" } },
      ]).lines,
    ).toEqual(['🔧 Editing "src/index.ts"']);
  });

  it("replaces the previous friendly line with the latest operation", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "Read", input: { file_path: "src/index.ts" } },
      { kind: "tool_use", toolName: "Edit", input: { file_path: "src/index.ts" } },
    ]);

    expect(lines).toEqual(['🔧 Editing "src/index.ts"']);
  });

  it("renders friendly search and shell operations with targets", () => {
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "Glob", input: { pattern: "**/*.ts" } },
      ]).lines,
    ).toEqual(['📂 Finding files matching "**/*.ts"']);
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "Grep", input: { pattern: "TOOL_PROGRESS_OPTIONS" } },
      ]).lines,
    ).toEqual(['🔎 Searching for "TOOL_PROGRESS_OPTIONS"']);
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "Bash", input: { command: "pnpm test" } },
      ]).lines,
    ).toEqual(['💻 Running "pnpm test"']);
  });

  it("collapses repeated identical friendly operations", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } },
      { kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } },
      { kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } },
    ]);

    expect(lines).toEqual(['🔧 Editing "a.ts" (x3)']);
  });

  it("renders Canvas CLI Bash calls as Canvas actions in friendly mode", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      {
        kind: "tool_use",
        toolName: "Bash",
        input: {
          command:
            '$CANVAS_CLI direct-execute-action --component-key slack-send-message --configured-props \'{"text":"hi"}\' --output json',
        },
      },
    ]);

    expect(lines).toEqual(['🧩 Canvas action: "slack-send-message"']);
  });

  it("renders quoted Canvas CLI Bash calls as Canvas actions in technical mode", () => {
    const { lines } = renderEvents({ toolProgress: "technical", reasoningText: false }, [
      {
        kind: "tool_use",
        toolName: "Bash",
        input: {
          command:
            "sh -c '\"$CANVAS_CLI\" direct-execute-action --component-key slack-send-message --output json' | jq .",
        },
      },
    ]);

    expect(lines).toEqual(['🧩 Canvas: "direct-execute-action slack-send-message"']);
  });

  it("renders Canvas web commands with the operation target", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      {
        kind: "tool_use",
        toolName: "Bash",
        input: {
          command: '$CANVAS_CLI direct-execute-web-search --query "TypeScript best practices" --limit 5 --output json',
        },
      },
    ]);

    expect(lines).toEqual(['🧩 Canvas web search: "TypeScript best practices"']);
  });

  it("renders delivery target search progress", () => {
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "mcp__sketch__SearchDeliveryTargets", input: { query: "engineering" } },
      ]).lines,
    ).toEqual(['📍 Searching delivery targets for "engineering"']);
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "mcp__sketch__SearchDeliveryTargets", input: { platform: "slack" } },
      ]).lines,
    ).toEqual(["📍 Listing delivery targets"]);
  });

  it("renders delivery target search in technical mode", () => {
    const { lines } = renderEvents({ toolProgress: "technical", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__sketch__SearchDeliveryTargets", input: { query: "engineering" } },
    ]);
    expect(lines).toEqual(['📍 SearchDeliveryTargets: "engineering"']);
  });

  it("renders a clear fallback for unknown tools with safe available input", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__google_drive__list_files", input: { folder: "root" } },
    ]);
    expect(lines).toEqual(['⚙️ list_files: "root"']);
  });

  it("renders chat history reads with a dedicated label", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__sketch__ReadChatHistory", input: {} },
    ]);
    expect(lines).toEqual(["💬 Reading Chat History"]);
  });

  it("renders chat history searches with the query", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__sketch__SearchChatHistory", input: { query: "launch budget" } },
    ]);
    expect(lines).toEqual(['🔎 Searching chat history for "launch budget"']);
  });

  it("renders visual analysis with the image path", () => {
    expect(
      renderEvents({ toolProgress: "friendly", reasoningText: false }, [
        { kind: "tool_use", toolName: "mcp__sketch__VisualAnalysis", input: { file_path: "attachments/photo.jpg" } },
      ]).lines,
    ).toEqual(['🖼️ Analyzing image "attachments/photo.jpg"']);
    expect(
      renderEvents({ toolProgress: "technical", reasoningText: false }, [
        { kind: "tool_use", toolName: "mcp__sketch__VisualAnalysis", input: { file_path: "attachments/photo.jpg" } },
      ]).lines,
    ).toEqual(['🖼️ VisualAnalysis: "attachments/photo.jpg"']);
  });

  it("renders local Mac commands without echoing the command", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__sketch__local_run_command", input: { command: "cat ~/.ssh/id_rsa" } },
    ]);
    expect(lines).toEqual(["💻 Running local Mac command"]);
  });

  it("does not include unsafe fallback input fields", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "UnknownTool", input: { apiKey: "secret", message: "hello" } },
    ]);
    expect(lines).toEqual(["⚙️ UnknownTool"]);
  });

  it("strips the mcp__<server>__ prefix in technical output", () => {
    const { lines } = renderEvents({ toolProgress: "technical", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__sketch__SendFileToChat", input: { file_path: "a.ts" } },
    ]);
    expect(lines).toEqual(['📎 SendFileToChat: "a.ts"']);
  });

  it("strips the mcp__<server>__ prefix when the server segment contains underscores", () => {
    const { lines } = renderEvents({ toolProgress: "friendly", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__plugin_pipedream__SendFileToChat", input: { file_path: "a.ts" } },
    ]);
    expect(lines).toEqual(['📎 Sending file "a.ts"']);
  });
});

describe("createWebProgressItem", () => {
  it("builds accurate friendly metadata for built-in tools without exposing arguments", () => {
    const event: ProgressEvent = { kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } };

    expect(createWebProgressItem(event, { toolProgress: "friendly", reasoningText: false })).toEqual({
      kind: "file",
      label: "Reading",
      icon: { type: "tool", name: "Read" },
      toolName: "Read",
    });
    expect(renderEvents({ toolProgress: "friendly", reasoningText: false }, [event]).lines).toEqual([
      '📖 Reading "notes.md"',
    ]);
  });

  it("builds technical tool progress metadata with the stripped tool name", () => {
    expect(
      createWebProgressItem(
        { kind: "tool_use", toolName: "mcp__sketch__SearchDeliveryTargets", input: { query: "engineering" } },
        { toolProgress: "technical", reasoningText: false },
      ),
    ).toEqual({
      kind: "delivery",
      label: "SearchDeliveryTargets",
      detail: "engineering",
      icon: { type: "tool", name: "SearchDeliveryTargets" },
      toolName: "SearchDeliveryTargets",
    });
  });

  it("builds friendly Canvas progress metadata without command details", () => {
    expect(
      createWebProgressItem(
        {
          kind: "tool_use",
          toolName: "Bash",
          input: {
            command:
              '$CANVAS_CLI direct-execute-action --component-key slack-send-message --configured-props \'{"text":"hi"}\' --output json',
          },
        },
        { toolProgress: "friendly", reasoningText: false },
      ),
    ).toEqual({
      kind: "canvas",
      label: "Running Canvas action",
      icon: { type: "canvas", name: "Canvas" },
      toolName: "Bash",
    });
  });

  it("clips friendly tool names before they enter web metadata", () => {
    const toolName = `mcp__plugin_${"x".repeat(120)}__${"y".repeat(120)}`;
    const item = createWebProgressItem(
      { kind: "tool_use", toolName, input: {} },
      { toolProgress: "friendly", reasoningText: false },
    );

    expect(item?.toolName).toHaveLength(43);
    expect(item?.toolName).toMatch(/^y{40}\.\.\.$/);
  });

  it("collapses disabled tool progress to generic thinking metadata", () => {
    expect(
      createWebProgressItem(
        { kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } },
        { toolProgress: "off", reasoningText: false },
      ),
    ).toEqual({
      kind: "reasoning",
      label: "Thinking…",
      icon: { type: "generic", name: "reasoning" },
    });
  });

  it("builds detailed reasoning metadata only in technical mode", () => {
    const event: ProgressEvent = { kind: "intermediate_text", text: "Checking config" };

    expect(createWebProgressItem(event, { toolProgress: "technical", reasoningText: true })).toEqual({
      kind: "reasoning",
      label: "Thinking",
      detail: "Checking config",
      icon: { type: "generic", name: "reasoning" },
    });
    expect(createWebProgressItem(event, { toolProgress: "off", reasoningText: true })).toEqual({
      kind: "reasoning",
      label: "Thinking…",
      icon: { type: "generic", name: "reasoning" },
    });
    expect(createWebProgressItem(event, { toolProgress: "friendly", reasoningText: false })).toBeNull();
  });

  it("uses accurate average-user labels for skills and integrations in friendly mode", () => {
    expect(
      createWebProgressItem(
        { kind: "tool_use", toolName: "Skill", input: { skill: "canvas-add-integration" } },
        { toolProgress: "friendly", reasoningText: false },
      ),
    ).toEqual({
      kind: "integration",
      label: "Running integration",
      icon: { type: "generic", name: "integration" },
      toolName: "Skill",
    });

    expect(
      createWebProgressItem(
        { kind: "tool_use", toolName: "mcp__google_drive__list_files", input: { folder: "root" } },
        { toolProgress: "friendly", reasoningText: false },
      ),
    ).toEqual({
      kind: "integration",
      label: "Running Google Drive integration",
      icon: { type: "generic", name: "integration" },
      toolName: "list_files",
    });

    expect(
      createWebProgressItem(
        { kind: "tool_use", toolName: "mcp__sketch__custom_tool", input: {} },
        { toolProgress: "friendly", reasoningText: false },
      ),
    ).toEqual({
      kind: "integration",
      label: "Running integration",
      icon: { type: "generic", name: "integration" },
      toolName: "custom_tool",
    });
  });
});

describe("createWebProgressData", () => {
  it("uses accurate friendly lines instead of Slack-style rendered lines", () => {
    const event: ProgressEvent = { kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } };

    expect(
      createWebProgressData(event, { toolProgress: "friendly", reasoningText: false }, "friendly", [
        '📖 Reading "notes.md"',
      ]),
    ).toEqual({
      lines: ["Reading"],
      items: [{ kind: "file", label: "Reading", icon: { type: "tool", name: "Read" }, toolName: "Read" }],
    });
  });

  it("keeps technical rendered lines and detailed metadata", () => {
    const event: ProgressEvent = { kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } };

    expect(
      createWebProgressData(event, { toolProgress: "technical", reasoningText: false }, "technical", [
        '📖 Read: "notes.md"',
      ]),
    ).toEqual({
      lines: ['📖 Read: "notes.md"'],
      items: [
        {
          kind: "file",
          label: "Read",
          detail: "notes.md",
          icon: { type: "tool", name: "Read" },
          toolName: "Read",
        },
      ],
    });
  });
});

describe("getProgressTransportStrategy", () => {
  it("returns none when both settings disable live progress", () => {
    expect(getProgressTransportStrategy({ toolProgress: "off", reasoningText: false })).toBe("none");
  });

  it("returns replace for enabled live progress modes", () => {
    expect(getProgressTransportStrategy({ toolProgress: "off", reasoningText: true })).toBe("replace");
    expect(getProgressTransportStrategy({ toolProgress: "friendly", reasoningText: false })).toBe("replace");
    expect(getProgressTransportStrategy({ toolProgress: "technical", reasoningText: true })).toBe("replace");
  });
});
