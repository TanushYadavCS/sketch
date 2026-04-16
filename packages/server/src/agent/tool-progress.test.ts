import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "./runner";
import { createProgressRenderer, getProgressTransportStrategy } from "./tool-progress";

function renderEvents(style: Parameters<typeof createProgressRenderer>[0], events: ProgressEvent[], random = () => 0) {
  const renderer = createProgressRenderer(style, random);
  const incremental = events.flatMap((event) => renderer.renderEvent(event));
  return { incremental, lines: renderer.getLines() };
}

describe("createProgressRenderer", () => {
  it("renders technical mode with clipped primary args", () => {
    const longPath = `src/${"very-long-folder-name/".repeat(3)}index.ts`;
    const { lines } = renderEvents("technical", [
      { kind: "tool_use", toolName: "Read", input: { file_path: longPath } },
    ]);

    expect(lines).toEqual([`📖 Read: "${longPath.slice(0, 40)}..."`]);
  });

  it("renders verbose mode with intermediate text and full args", () => {
    const { lines } = renderEvents("verbose", [
      { kind: "intermediate_text", text: "Let me check the config" },
      { kind: "tool_use", toolName: "Read", input: { file_path: "config.json", recursive: true } },
    ]);

    expect(lines).toEqual(["💬 Let me check the config", '📖 Read: {"file_path":"config.json","recursive":true}']);
  });

  it("suppresses intermediate text outside verbose mode", () => {
    const { lines } = renderEvents("friendly", [{ kind: "intermediate_text", text: "Thinking..." }]);
    expect(lines).toEqual([]);
  });

  it("reuses the same friendly line for consecutive identical tool calls and dedups the history", () => {
    const { incremental, lines } = renderEvents(
      "friendly",
      [
        { kind: "tool_use", toolName: "Edit", input: {} },
        { kind: "tool_use", toolName: "Edit", input: {} },
        { kind: "tool_use", toolName: "Edit", input: {} },
      ],
      () => 0,
    );

    expect(incremental).toEqual(["🔧 Tweaking things", "🔧 Tweaking things", "🔧 Tweaking things"]);
    expect(lines).toEqual(["🔧 Tweaking things (x3)"]);
  });

  it("concise mode keeps only the latest tool line", () => {
    const renderer = createProgressRenderer("concise", () => 0);

    expect(renderer.renderEvent({ kind: "tool_use", toolName: "Read", input: {} })).toEqual([
      "📖 Flipping through some pages",
    ]);
    expect(renderer.getLines()).toEqual(["📖 Flipping through some pages"]);

    expect(renderer.renderEvent({ kind: "tool_use", toolName: "Bash", input: {} })).toEqual(["🚀 Running commands"]);
    expect(renderer.getLines()).toEqual(["🚀 Running commands"]);
  });

  it("uses the fallback friendly pool for unknown tools", () => {
    const { lines } = renderEvents("friendly", [{ kind: "tool_use", toolName: "SomeMcpTool", input: {} }], () => 0);
    expect(lines).toEqual(["⚙️ Working on it"]);
  });
});

describe("getProgressTransportStrategy", () => {
  it("uses replace mode only for concise", () => {
    expect(getProgressTransportStrategy("concise")).toBe("replace");
    expect(getProgressTransportStrategy("friendly")).toBe("accumulate");
    expect(getProgressTransportStrategy("technical")).toBe("accumulate");
    expect(getProgressTransportStrategy("verbose")).toBe("accumulate");
  });
});
