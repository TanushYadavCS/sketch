import { describe, expect, it } from "vitest";
import type { AgentRuntimeCompactionResult, AgentRuntimePersistedCompactionRow } from "./contracts";

describe("agent runtime compaction contracts", () => {
  it("represents cache breakpoint re-anchoring after compaction", () => {
    const result: AgentRuntimeCompactionResult = {
      trigger: {
        behavior: "compact",
        estimatedInputTokens: 92_000,
        thresholdTokens: 80_000,
        config: { thresholdFraction: 0.8, contextWindowTokens: 100_000 },
      },
      persistedSummaryRow: {
        id: "msg-compact-1",
        session_id: "session-1",
        seq: 42,
        role: "user",
        content: {
          marker: { marker: "sketch.agent_runtime.compaction_summary", version: 1, trigger: "auto" },
          summary: { behavior: "summary", summary: "Earlier context was summarized." },
        },
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 41,
        keepRecentTail: { startSeq: 42, checkedPairs: [], splitsToolCallResultPair: false },
        created_at: "2026-07-04T00:00:00.000Z",
      },
      cacheBreakpointReanchor: {
        behavior: "reanchor_after_compaction",
        targets: ["system_prompt", "last_message"],
        anchorAfterSeq: 42,
        reason: "summary_replaces_truncated_prefix",
      },
      keepRecentTail: { startSeq: 42, checkedPairs: [], splitsToolCallResultPair: false },
    };

    expect(result.cacheBreakpointReanchor.targets).toEqual(["system_prompt", "last_message"]);
    expect(result.cacheBreakpointReanchor.anchorAfterSeq).toBe(result.persistedSummaryRow.seq);
  });

  it("keeps Pi's empty-summary compaction quirk as an explicit covered edge case", () => {
    const row: AgentRuntimePersistedCompactionRow = {
      id: "msg-compact-empty",
      session_id: "session-1",
      seq: 12,
      role: "system",
      content: {
        marker: { marker: "sketch.agent_runtime.compaction_summary", version: 1, trigger: "manual" },
        summary: { behavior: "empty_summary_pi_quirk", summary: "", testCoverage: "required" },
      },
      replacedPrefixStartSeq: 1,
      replacedPrefixEndSeq: 11,
      keepRecentTail: { startSeq: 12, checkedPairs: [], splitsToolCallResultPair: false },
      created_at: "2026-07-04T00:00:00.000Z",
    };

    expect(row.content.summary).toEqual({
      behavior: "empty_summary_pi_quirk",
      summary: "",
      testCoverage: "required",
    });
  });
});
