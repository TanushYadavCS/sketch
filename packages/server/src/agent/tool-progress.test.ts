import { describe, expect, it } from "vitest";
import type { ProgressDisplaySettings } from "../progress-settings";
import type { ProgressEvent } from "./runner";
import { createProgressRenderer, getProgressTransportStrategy } from "./tool-progress";

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
    expect(lines).toEqual(['⚙️ Using list_files: "root"']);
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
    expect(lines).toEqual(["⚙️ Using UnknownTool"]);
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
