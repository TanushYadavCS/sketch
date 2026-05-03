import { describe, expect, it } from "vitest";
import { REASONING_TEXT_OPTIONS, TOOL_PROGRESS_OPTIONS } from "../commands";
import { HOME_ACTION_REASONING_TEXT, HOME_ACTION_TOOL_PROGRESS, buildHomeView } from "./home";

interface BlockKitOption {
  text: { type: string; text: string };
  value: string;
}

interface StaticSelect {
  type: "static_select";
  action_id: string;
  options: BlockKitOption[];
  initial_option: BlockKitOption;
}

interface ActionsBlock {
  type: "actions";
  block_id?: string;
  elements: StaticSelect[];
}

function findActionsBlock(view: ReturnType<typeof buildHomeView>, blockId: string): ActionsBlock {
  const block = view.blocks.find((b) => b.type === "actions" && b.block_id === blockId);
  if (!block) throw new Error(`actions block ${blockId} not found`);
  return block as unknown as ActionsBlock;
}

function getSelect(block: ActionsBlock): StaticSelect {
  const select = block.elements[0];
  if (!select) throw new Error("select element missing");
  return select;
}

describe("buildHomeView", () => {
  const baseParams = {
    realName: "Alex",
    email: "alex@example.com" as string | null,
    workspaceName: "Acme" as string | null,
    toolProgress: "friendly" as const,
    reasoningText: false,
  };

  it("renders the identity block with email and workspace when provided", () => {
    const view = buildHomeView(baseParams);
    const identity = view.blocks.find(
      (b) => b.type === "section" && (b as { text?: { text?: string } }).text?.text?.includes("Signed in as"),
    ) as { text: { text: string } } | undefined;
    expect(identity?.text.text).toContain("Signed in as *Alex*");
    expect(identity?.text.text).toContain("alex@example.com");
    expect(identity?.text.text).toContain("Acme");
  });

  it("omits email and workspace lines when those fields are null", () => {
    const view = buildHomeView({ ...baseParams, email: null, workspaceName: null });
    const identity = view.blocks.find(
      (b) => b.type === "section" && (b as { text?: { text?: string } }).text?.text?.includes("Signed in as"),
    ) as { text: { text: string } } | undefined;
    expect(identity?.text.text).toBe("Signed in as *Alex*");
  });

  it("wires the tool-progress select with the right action_id, options, and initial value", () => {
    const view = buildHomeView({ ...baseParams, toolProgress: "concise" });
    const select = getSelect(findActionsBlock(view, "home_tool_progress_actions"));

    expect(select.type).toBe("static_select");
    expect(select.action_id).toBe(HOME_ACTION_TOOL_PROGRESS);
    expect(select.options.map((o) => o.value)).toEqual([...TOOL_PROGRESS_OPTIONS]);
    expect(select.initial_option.value).toBe("concise");
    expect(select.initial_option.text.text).toBe("Concise");
  });

  it("wires the reasoning-text select with the right action_id, options, and initial value", () => {
    const view = buildHomeView({ ...baseParams, reasoningText: true });
    const select = getSelect(findActionsBlock(view, "home_reasoning_text_actions"));

    expect(select.action_id).toBe(HOME_ACTION_REASONING_TEXT);
    expect(select.options.map((o) => o.value)).toEqual([...REASONING_TEXT_OPTIONS]);
    expect(select.initial_option.value).toBe("on");
    expect(select.initial_option.text.text).toBe("On");
  });

  it("reflects reasoningText: false as the 'off' initial option", () => {
    const view = buildHomeView({ ...baseParams, reasoningText: false });
    const select = getSelect(findActionsBlock(view, "home_reasoning_text_actions"));
    expect(select.initial_option.value).toBe("off");
  });

  it("renders exactly one tool-progress and one reasoning-text actions block", () => {
    const view = buildHomeView(baseParams);
    const actionsBlocks = view.blocks.filter((b) => b.type === "actions");
    const blockIds = actionsBlocks.map((b) => (b as { block_id?: string }).block_id);
    expect(blockIds).toEqual(["home_tool_progress_actions", "home_reasoning_text_actions"]);
  });
});
