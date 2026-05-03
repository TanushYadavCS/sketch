import { describe, expect, it } from "vitest";
import type { ProgressDisplaySettings } from "../progress-settings";
import type { ProgressEvent } from "./runner";
import { createProgressRenderer, getProgressTransportStrategy } from "./tool-progress";

function renderEvents(settings: ProgressDisplaySettings, events: ProgressEvent[], random = () => 0) {
  const renderer = createProgressRenderer(settings, random);
  for (const event of events) {
    renderer.renderEvent(event);
  }
  return { lines: renderer.getLines() };
}

describe("createProgressRenderer", () => {
  it("renders technical mode with clipped primary args", () => {
    const longPath = `src/${"very-long-folder-name/".repeat(3)}index.ts`;
    const { lines } = renderEvents({ toolProgress: "technical", reasoningText: false }, [
      { kind: "tool_use", toolName: "Read", input: { file_path: longPath } },
    ]);

    expect(lines).toEqual([`📖 Read: "${longPath.slice(0, 40)}..."`]);
  });

  it("renders verbose mode with intermediate text when reasoning text is enabled", () => {
    const { lines } = renderEvents({ toolProgress: "verbose", reasoningText: true }, [
      { kind: "intermediate_text", text: "Let me check the config" },
      { kind: "tool_use", toolName: "Read", input: { file_path: "config.json", recursive: true } },
    ]);

    expect(lines).toEqual(["💬 Let me check the config", '📖 Read: {"file_path":"config.json","recursive":true}']);
  });

  it("suppresses intermediate text when reasoning text is off", () => {
    const { lines } = renderEvents({ toolProgress: "verbose", reasoningText: false }, [
      { kind: "intermediate_text", text: "Thinking..." },
    ]);
    expect(lines).toEqual([]);
  });

  it("reuses the same friendly line for consecutive identical tool calls and dedups the history", () => {
    const { lines } = renderEvents(
      { toolProgress: "friendly", reasoningText: false },
      [
        { kind: "tool_use", toolName: "Edit", input: {} },
        { kind: "tool_use", toolName: "Edit", input: {} },
        { kind: "tool_use", toolName: "Edit", input: {} },
      ],
      () => 0,
    );

    expect(lines).toEqual(["🔧 Tweaking things (x3)"]);
  });

  it("concise mode keeps only the latest tool line", () => {
    const renderer = createProgressRenderer({ toolProgress: "concise", reasoningText: false }, () => 0);

    renderer.renderEvent({ kind: "tool_use", toolName: "Read", input: {} });
    expect(renderer.getLines()).toEqual(["📖 Flipping through some pages"]);

    renderer.renderEvent({ kind: "tool_use", toolName: "Bash", input: {} });
    expect(renderer.getLines()).toEqual(["🚀 Running commands"]);
  });

  it("concise mode replaces with reasoning text when enabled", () => {
    const renderer = createProgressRenderer({ toolProgress: "concise", reasoningText: true }, () => 0);

    renderer.renderEvent({ kind: "tool_use", toolName: "Read", input: {} });
    renderer.renderEvent({ kind: "intermediate_text", text: "Checking config" });
    expect(renderer.getLines()).toEqual(["💬 Checking config"]);
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
      { kind: "tool_use", toolName: "Read", input: {} },
    ]);
    expect(lines).toEqual([]);
  });

  it("uses the fallback friendly pool for unknown tools", () => {
    const { lines } = renderEvents(
      { toolProgress: "friendly", reasoningText: false },
      [{ kind: "tool_use", toolName: "SomeMcpTool", input: {} }],
      () => 0,
    );
    expect(lines).toEqual(["⚙️ Working on it"]);
  });

  it("strips the mcp__<server>__ prefix when picking the friendly pool", () => {
    const { lines } = renderEvents(
      { toolProgress: "friendly", reasoningText: false },
      [{ kind: "tool_use", toolName: "mcp__sketch__SendFileToChat", input: { file_path: "a.ts" } }],
      () => 0,
    );
    expect(lines).toEqual(["📦 Wrapping up a file for you"]);
  });

  it("strips the mcp__<server>__ prefix in technical mode and renders the bare name with primary arg", () => {
    const { lines } = renderEvents({ toolProgress: "technical", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__sketch__SendFileToChat", input: { file_path: "a.ts" } },
    ]);
    expect(lines).toEqual(['📎 SendFileToChat: "a.ts"']);
  });

  it("strips the mcp__<server>__ prefix in verbose mode and renders the bare name with full input", () => {
    const { lines } = renderEvents({ toolProgress: "verbose", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__sketch__SendFileToChat", input: { file_path: "a.ts" } },
    ]);
    expect(lines).toEqual(['📎 SendFileToChat: {"file_path":"a.ts"}']);
  });

  it("strips the mcp__<server>__ prefix when the server segment contains underscores", () => {
    const { lines } = renderEvents({ toolProgress: "technical", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__plugin_pipedream__SendFileToChat", input: { file_path: "a.ts" } },
    ]);
    expect(lines).toEqual(['📎 SendFileToChat: "a.ts"']);
  });

  it("strips the mcp__<server>__ prefix only up to the first __ so underscores in the tool name survive", () => {
    const { lines } = renderEvents({ toolProgress: "verbose", reasoningText: false }, [
      { kind: "tool_use", toolName: "mcp__google_drive__list_files", input: { folder: "root" } },
    ]);
    expect(lines).toEqual(['⚙️ list_files: {"folder":"root"}']);
  });

  it("strips the mcp__<server>__ prefix in friendly mode for an underscored server", () => {
    const { lines } = renderEvents(
      { toolProgress: "friendly", reasoningText: false },
      [{ kind: "tool_use", toolName: "mcp__plugin_pipedream__SendFileToChat", input: {} }],
      () => 0,
    );
    expect(lines).toEqual(["📦 Wrapping up a file for you"]);
  });
});

describe("getProgressTransportStrategy", () => {
  it("returns replace only for concise", () => {
    expect(getProgressTransportStrategy({ toolProgress: "concise", reasoningText: false })).toBe("replace");
  });

  it("returns none when both settings disable live progress", () => {
    expect(getProgressTransportStrategy({ toolProgress: "off", reasoningText: false })).toBe("none");
  });

  it("returns accumulate for reasoning-only and accumulate styles", () => {
    expect(getProgressTransportStrategy({ toolProgress: "off", reasoningText: true })).toBe("accumulate");
    expect(getProgressTransportStrategy({ toolProgress: "friendly", reasoningText: false })).toBe("accumulate");
    expect(getProgressTransportStrategy({ toolProgress: "technical", reasoningText: true })).toBe("accumulate");
    expect(getProgressTransportStrategy({ toolProgress: "verbose", reasoningText: false })).toBe("accumulate");
  });
});
