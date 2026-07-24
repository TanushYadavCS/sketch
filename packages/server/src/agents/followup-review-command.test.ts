import { describe, expect, it, vi } from "vitest";
import { createFollowupReviewCommandHandler } from "./followup-review-command";

const NOW = "2026-07-16T12:00:00.000Z";

function makeDeps() {
  return {
    users: {
      getVerifiedEmailsForUser: vi.fn().mockResolvedValue(["alice@example.com", "alice@work.example"]),
    },
    entities: {
      getPersonEntitiesByEmails: vi.fn().mockResolvedValue(
        new Map([
          ["alice@example.com", [{ id: "person-1" }]],
          ["alice@work.example", [{ id: "person-1" }, { id: "person-2" }]],
        ]),
      ),
    },
    followups: {
      reviewRecommendation: vi.fn(),
    },
    transition: {
      reviewSeedCandidate: vi.fn(),
    },
    now: vi.fn(() => NOW),
  };
}

describe("createFollowupReviewCommandHandler", () => {
  it.each([
    {
      text: "  confirm   done a1b2  ",
      action: "confirm_done" as const,
      repositoryStatus: { status: "confirmed" as const, taskId: "task-1" },
      message: "Marked the follow-up done.",
    },
    {
      text: "KEEP OPEN z9y8",
      action: "keep_open" as const,
      repositoryStatus: { status: "kept_open" as const, taskId: "task-1" },
      message: "Kept the follow-up open.",
    },
  ])("handles normalized recommendation command: $action", async ({ text, action, repositoryStatus, message }) => {
    const deps = makeDeps();
    deps.followups.reviewRecommendation.mockResolvedValue(repositoryStatus);
    const handler = createFollowupReviewCommandHandler({} as never, deps);

    await expect(handler({ text, userId: "user-1", surface: "slack" })).resolves.toEqual({
      handled: true,
      message,
    });
    expect(deps.users.getVerifiedEmailsForUser).toHaveBeenCalledWith("user-1");
    expect(deps.entities.getPersonEntitiesByEmails).toHaveBeenCalledWith(["alice@example.com", "alice@work.example"]);
    expect(deps.followups.reviewRecommendation).toHaveBeenCalledWith({
      code: action === "confirm_done" ? "A1B2" : "Z9Y8",
      action,
      userId: "user-1",
      assigneeEntityIds: ["person-1", "person-2"],
      surface: "slack",
      now: NOW,
    });
    expect(deps.transition.reviewSeedCandidate).not.toHaveBeenCalled();
  });

  it.each([
    {
      text: "track ab12",
      decision: "track" as const,
      repositoryStatus: { status: "accepted" as const, taskId: "task-1", mode: "hybrid" as const },
      message: "Now tracking that follow-up.",
    },
    {
      text: "Dismiss CD34",
      decision: "dismiss" as const,
      repositoryStatus: { status: "dismissed" as const, mode: "durable_only" as const },
      message: "Dismissed that reconstructed follow-up.",
    },
  ])("handles normalized seed command: $decision", async ({ text, decision, repositoryStatus, message }) => {
    const deps = makeDeps();
    deps.transition.reviewSeedCandidate.mockResolvedValue(repositoryStatus);
    const handler = createFollowupReviewCommandHandler({} as never, deps);

    await expect(handler({ text, userId: "user-1", surface: "whatsapp" })).resolves.toEqual({
      handled: true,
      message,
    });
    expect(deps.transition.reviewSeedCandidate).toHaveBeenCalledWith({
      userId: "user-1",
      code: decision === "track" ? "AB12" : "CD34",
      decision,
      surface: "whatsapp",
      now: NOW,
    });
    expect(deps.users.getVerifiedEmailsForUser).not.toHaveBeenCalled();
    expect(deps.followups.reviewRecommendation).not.toHaveBeenCalled();
  });

  it("does not handle unrelated text", async () => {
    const deps = makeDeps();
    const handler = createFollowupReviewCommandHandler({} as never, deps);

    await expect(handler({ text: "please keep this open", userId: "user-1", surface: "slack" })).resolves.toEqual({
      handled: false,
    });
  });

  it.each([
    { status: "stale", message: "That follow-up review was already handled or has expired." },
    { status: "unauthorized", message: "I couldn't find an active follow-up review for that code." },
    { status: "not_found", message: "I couldn't find an active follow-up review for that code." },
  ])("returns safe recommendation messaging for $status", async ({ status, message }) => {
    const deps = makeDeps();
    deps.followups.reviewRecommendation.mockResolvedValue({ status });
    const handler = createFollowupReviewCommandHandler({} as never, deps);

    await expect(handler({ text: "confirm done ABCD", userId: "user-1", surface: "slack" })).resolves.toEqual({
      handled: true,
      message,
    });
  });

  it.each([
    {
      repositoryStatus: { status: "already_reviewed", decision: "track", mode: "hybrid" },
      message: "That follow-up review was already handled.",
    },
    {
      repositoryStatus: { status: "not_found" },
      message: "I couldn't find an active follow-up review for that code.",
    },
  ])("returns safe seed messaging for $repositoryStatus.status", async ({ repositoryStatus, message }) => {
    const deps = makeDeps();
    deps.transition.reviewSeedCandidate.mockResolvedValue(repositoryStatus);
    const handler = createFollowupReviewCommandHandler({} as never, deps);

    await expect(handler({ text: "track ABCD", userId: "user-1", surface: "whatsapp" })).resolves.toEqual({
      handled: true,
      message,
    });
  });

  it("returns a retryable failure message without throwing", async () => {
    const deps = makeDeps();
    deps.followups.reviewRecommendation.mockRejectedValue(new Error("database unavailable"));
    const handler = createFollowupReviewCommandHandler({} as never, deps);

    await expect(handler({ text: "keep open ABCD", userId: "user-1", surface: "slack" })).resolves.toEqual({
      handled: true,
      message: "I couldn't update that follow-up right now. Please try again.",
    });
  });
});
