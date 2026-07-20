import { describe, expect, it } from "vitest";
import type { AgentOutputItemInput } from "../db/repositories/agent-outputs";
import { reconcileFollowupReminderItems } from "./followup-reminder";

function modelTodo(title: string, structuredPayload?: AgentOutputItemInput["structuredPayload"]): AgentOutputItemInput {
  return {
    sectionKey: "todos",
    title,
    summary: `${title} from model context.`,
    priority: "medium",
    label: "todo",
    structuredPayload,
    knowledgeRefs: { entityIds: ["project-1"], fileIds: [] },
    sortOrder: 0,
  };
}

describe("reconcileFollowupReminderItems", () => {
  it("renders tracked, untracked, and reviewable follow-ups without duplicates", () => {
    const result = reconcileFollowupReminderItems(
      [modelTodo("Send revised proposal", { taskId: "task-1" }), modelTodo("Prepare board deck")],
      {
        status: "ok",
        mode: "hybrid",
        pending: [
          {
            taskId: "task-1",
            title: "Send revised proposal",
            priority: "high",
            parentEntityId: "project-1",
            assigneeEntityId: "person-1",
          },
        ],
        looksResolved: [
          {
            recommendationId: "recommendation-1",
            taskId: "task-2",
            title: "Confirm reseller pricing",
            rationale: "Ashish reported that pricing was confirmed.",
            reviewCode: "R7K2",
            parentEntityId: "project-1",
            assigneeEntityId: "person-1",
          },
        ],
        untracked: [
          {
            candidateId: "seed-1",
            title: "Check launch analytics",
            summary: "Reconstructed from a recent Summarizer output.",
            reviewCode: "S4E9",
            parentEntityId: null,
            assigneeEntityId: null,
          },
        ],
      },
    );

    expect(result.map((item) => [item.sectionKey, item.title])).toEqual([
      ["todos", "Prepare board deck"],
      ["todos", "Send revised proposal"],
      ["untracked_followups", "Check launch analytics"],
      ["looks_resolved", "Confirm reseller pricing"],
    ]);
    expect(result[1]).toMatchObject({
      label: "todo",
      canonicalTaskId: "task-1",
      structuredPayload: { serverOwnedFollowup: true, taskId: "task-1", trackingState: "durable" },
      knowledgeRefs: { entityIds: ["project-1", "person-1"], fileIds: [] },
    });
    expect(result[2]).not.toHaveProperty("canonicalTaskId");
    expect(result[2]?.summary).toContain("Track S4E9");
    expect(result[2]?.summary).toContain("Dismiss S4E9");
    expect(result[3]).toMatchObject({ canonicalTaskId: "task-2" });
    expect(result[3]?.summary).toContain("Confirm done R7K2");
    expect(result[3]?.summary).toContain("Keep open R7K2");
  });

  it("keeps unrelated model todos that only share a normalized title", () => {
    const result = reconcileFollowupReminderItems(
      [
        modelTodo("Send revised proposal"),
        modelTodo(" SEND   REVISED PROPOSAL ", { sourceKey: "jira:project:OPS" }),
        modelTodo("Send revised proposal", { sourceKey: "gmail:thread:abc" }),
      ],
      {
        status: "ok",
        mode: "hybrid",
        pending: [
          {
            taskId: "task-1",
            title: "Send revised proposal",
            priority: "high",
            parentEntityId: "project-1",
            assigneeEntityId: "person-1",
          },
        ],
        looksResolved: [],
        untracked: [],
      },
    );

    expect(result.map((item) => [item.title, item.structuredPayload?.sourceKey ?? null])).toEqual([
      ["Send revised proposal", null],
      [" SEND   REVISED PROPOSAL ", "jira:project:OPS"],
      ["Send revised proposal", "gmail:thread:abc"],
      ["Send revised proposal", null],
    ]);
  });

  it("replaces a model todo only when its source-scoped identity exactly matches", () => {
    const result = reconcileFollowupReminderItems(
      [
        modelTodo("Send revised proposal", { sourceKey: "slack:channel:C_MATCH" }),
        modelTodo("Send revised proposal", { sourceKey: "slack:channel:C_OTHER" }),
      ],
      {
        status: "ok",
        mode: "hybrid",
        pending: [
          {
            taskId: "task-1",
            title: "Send revised proposal",
            priority: "high",
            parentEntityId: "project-1",
            assigneeEntityId: "person-1",
            sourceKey: "slack:channel:C_MATCH",
          },
        ],
        looksResolved: [],
        untracked: [],
      },
    );

    expect(result.map((item) => [item.title, item.structuredPayload?.sourceKey ?? null])).toEqual([
      ["Send revised proposal", "slack:channel:C_OTHER"],
      ["Send revised proposal", "slack:channel:C_MATCH"],
    ]);
  });

  it("replaces a server-owned todo carrying the exact recommendation identity", () => {
    const result = reconcileFollowupReminderItems(
      [
        modelTodo("Confirm reseller pricing", {
          serverOwnedFollowup: true,
          recommendationId: "recommendation-1",
        }),
      ],
      {
        status: "ok",
        mode: "durable_only",
        pending: [],
        looksResolved: [
          {
            recommendationId: "recommendation-1",
            taskId: "task-2",
            title: "Confirm reseller pricing",
            rationale: "Pricing was confirmed.",
            reviewCode: "R7K2",
            parentEntityId: "project-1",
            assigneeEntityId: "person-1",
          },
        ],
        untracked: [],
      },
    );

    expect(result).toEqual([
      expect.objectContaining({
        sectionKey: "looks_resolved",
        structuredPayload: expect.objectContaining({ recommendationId: "recommendation-1" }),
      }),
    ]);
  });

  it("removes resolved conversation todos by durable or exact source identity without suppressing same-title work", () => {
    const result = reconcileFollowupReminderItems(
      [
        modelTodo("Send revised proposal", { serverOwnedFollowup: true, taskId: "task-1" }),
        modelTodo("Send revised proposal", {
          sourceKey: "slack:channel:C_MATCH",
          sourceAnchorKey: "slack:42:root",
        }),
        modelTodo("Send revised proposal", { sourceKey: "jira:project:OPS" }),
        modelTodo("Send revised proposal", { sourceKey: "gmail:thread:abc" }),
        modelTodo("Send revised proposal"),
      ],
      {
        status: "ok",
        mode: "durable_only",
        pending: [],
        looksResolved: [],
        untracked: [],
        suppressed: [
          {
            taskId: "task-1",
            title: "Send revised proposal",
            sourceKey: "slack:channel:C_MATCH",
            sourceAnchorKey: "slack:42:root",
          },
        ],
      },
    );

    expect(result.map((item) => item.structuredPayload?.sourceKey ?? null)).toEqual([
      "jira:project:OPS",
      "gmail:thread:abc",
      null,
    ]);
  });

  it("does not render a pending seed proposal again as a legacy untracked item with the same source identity", () => {
    const result = reconcileFollowupReminderItems([], {
      status: "ok",
      mode: "hybrid",
      pending: [],
      looksResolved: [],
      untracked: [
        {
          candidateId: "seed-1",
          title: "Follow up with Acme",
          summary: "Review this seed proposal.",
          reviewCode: "S4E9",
          parentEntityId: null,
          assigneeEntityId: null,
          sourceKey: "slack:channel:C_ACME",
          sourceAnchorKey: "slack:42:root",
        },
        {
          candidateId: "legacy-1",
          title: "Follow up with Acme",
          summary: "Reconstructed from a recent summary.",
          reviewCode: null,
          parentEntityId: null,
          assigneeEntityId: null,
          sourceKey: "slack:channel:C_ACME",
          sourceAnchorKey: "slack:42:root",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sectionKey: "untracked_followups",
      structuredPayload: {
        candidateId: "seed-1",
        reviewCode: "S4E9",
        sourceKey: "slack:channel:C_ACME",
        sourceAnchorKey: "slack:42:root",
      },
    });
  });

  it("places stable review commands before a long rationale so delivery clipping preserves them", () => {
    const result = reconcileFollowupReminderItems([], {
      status: "ok",
      mode: "durable_only",
      pending: [],
      untracked: [],
      looksResolved: [
        {
          recommendationId: "recommendation-long",
          taskId: "task-long",
          title: "Review long completion rationale",
          rationale: "Detailed completion evidence. ".repeat(30),
          reviewCode: "L0NG",
          parentEntityId: null,
          assigneeEntityId: "person-1",
        },
      ],
    });

    expect(result[0]?.summary).toMatch(/^Reply "Confirm done L0NG" or "Keep open L0NG"\./);
  });

  it("places seed review commands before a long summary so delivery clipping preserves them", () => {
    const result = reconcileFollowupReminderItems([], {
      status: "ok",
      mode: "hybrid",
      pending: [],
      looksResolved: [],
      untracked: [
        {
          candidateId: "seed-long",
          title: "Review reconstructed follow-up",
          summary: "S".repeat(400),
          reviewCode: "S4E9",
          parentEntityId: null,
          assigneeEntityId: null,
        },
      ],
    });

    expect(result[0]?.summary).toMatch(/^Reply "Track S4E9" or "Dismiss S4E9"\./);
  });

  it("keeps fallback explicitly labelled when the durable query fails", () => {
    const result = reconcileFollowupReminderItems([], {
      status: "error",
      code: "durable_query_failed",
      retryable: true,
      fallback: [
        {
          candidateId: "legacy-1",
          title: "Follow up with reseller",
          summary: "Recovered from the prior summary.",
          reviewCode: null,
          parentEntityId: null,
          assigneeEntityId: null,
        },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        sectionKey: "untracked_followups",
        title: "Follow up with reseller",
        summary: expect.stringContaining("tracking is temporarily unavailable"),
        structuredPayload: expect.objectContaining({ trackingState: "fallback_error" }),
      }),
    ]);
  });

  it("caps server-owned reminder reconciliation by section", () => {
    const result = reconcileFollowupReminderItems(
      [],
      {
        status: "ok",
        mode: "hybrid",
        pending: Array.from({ length: 4 }, (_, index) => ({
          taskId: `task-${index}`,
          title: `Pending ${index}`,
          priority: "medium",
          parentEntityId: null,
          assigneeEntityId: null,
        })),
        looksResolved: Array.from({ length: 4 }, (_, index) => ({
          recommendationId: `recommendation-${index}`,
          taskId: `resolved-task-${index}`,
          title: `Resolved ${index}`,
          rationale: "Reported complete.",
          reviewCode: `R${index}`,
          parentEntityId: null,
          assigneeEntityId: null,
        })),
        untracked: Array.from({ length: 4 }, (_, index) => ({
          candidateId: `candidate-${index}`,
          title: `Untracked ${index}`,
          summary: "Recovered.",
          reviewCode: null,
          parentEntityId: null,
          assigneeEntityId: null,
        })),
      },
      2,
    );

    expect(result.filter((item) => item.sectionKey === "todos")).toHaveLength(2);
    expect(result.filter((item) => item.sectionKey === "looks_resolved")).toHaveLength(2);
    expect(result.filter((item) => item.sectionKey === "untracked_followups")).toHaveLength(2);
  });
});
