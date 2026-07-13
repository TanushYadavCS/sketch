import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatConversationLoadError, ChatConversationSkeleton, ChatRecoveryStatus } from "./chat-route-state";

describe("ChatConversationSkeleton", () => {
  it("presents the conversation loading state", () => {
    render(<ChatConversationSkeleton />);

    expect(screen.getByLabelText("Loading conversation")).toBeInTheDocument();
  });
});

describe("ChatRecoveryStatus", () => {
  it("shows the reconnecting state", () => {
    render(<ChatRecoveryStatus stage="reconnecting" onRetry={() => undefined} />);

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });

  it("shows the persistent recovery state", () => {
    render(<ChatRecoveryStatus stage="persistent" onRetry={() => undefined} />);

    expect(screen.getByText("Connection interrupted. Retrying…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
  });

  it("retries once when Retry now is clicked", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ChatRecoveryStatus stage="persistent" onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "Retry now" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("ChatConversationLoadError", () => {
  it("presents an alert with a retry action", () => {
    render(<ChatConversationLoadError onRetry={() => undefined} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load this conversation.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retries exactly once when Retry is clicked", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ChatConversationLoadError onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
