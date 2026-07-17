import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePane } from "./home-pane";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
    onMouseEnter,
    onFocus,
  }: {
    to: string;
    params?: { conversationId?: string };
    children: React.ReactNode;
    className?: string;
    onMouseEnter?: React.MouseEventHandler<HTMLAnchorElement>;
    onFocus?: React.FocusEventHandler<HTMLAnchorElement>;
  }) => (
    <a
      href={params?.conversationId ? `/chat/${params.conversationId}` : to}
      className={className}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
    >
      {children}
    </a>
  ),
}));

const originalMediaDevices = navigator.mediaDevices;

describe("HomePane", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
  });

  it("uses the shared dashboard tab content width and fits the viewport at narrow widths", () => {
    const { container } = render(<HomePane firstName="Karan" onSubmit={() => undefined} />);

    expect(container.firstElementChild).toHaveClass(
      "mx-auto",
      "box-content",
      "max-w-4xl",
      "px-4",
      "py-8",
      "sm:px-10",
      "w-[calc(100%-32px)]",
      "sm:w-[calc(100%-80px)]",
    );
    expect(container.firstElementChild?.className).not.toContain("max-w-[");
    expect(container.firstElementChild?.className).not.toContain("w-full");
  });

  it("keeps Home as a launcher and renders the design's empty Recents state", () => {
    render(<HomePane firstName="Karan" onSubmit={() => undefined} />);

    expect(screen.queryByLabelText("Chat thread")).not.toBeInTheDocument();
    expect(screen.getByText("Recents")).toBeInTheDocument();
    expect(screen.getByText("Your conversations will appear here")).toBeInTheDocument();
  });

  it("prefills the chat input when a suggested prompt chip is clicked", async () => {
    const user = userEvent.setup();
    render(<HomePane firstName="Karan" onSubmit={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Triage inbox" }));

    expect(screen.getByLabelText("Message Sketch")).toHaveValue("Triage my inbox from the last 24 hours");
  });

  it("keeps the recording state visible under the app StrictMode wrapper", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: RecordingState = "inactive";
      mimeType: string;
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? "";
      }

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    render(
      <StrictMode>
        <HomePane firstName="Karan" onSubmit={() => undefined} />
      </StrictMode>,
    );

    await user.click(screen.getByLabelText("Record voice"));

    expect(await screen.findByPlaceholderText("Recording... click stop when done")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
  });

  it("renders Recents with the same section and row copy as the provided design", () => {
    render(
      <HomePane
        firstName="Karan"
        onSubmit={() => undefined}
        recents={[
          {
            id: "web-chat",
            title: "Create a PDF for my skills",
            channel: "web",
            occurredAt: "2026-05-26T06:30:00.000Z",
            now: new Date("2026-05-26T06:48:00.000Z"),
          },
        ]}
      />,
    );

    expect(screen.getByText("Recent conversations")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create a PDF for my skills/i })).toHaveAttribute("href", "/chat/web-chat");
    expect(screen.getByText("18m")).toBeInTheDocument();
    expect(screen.queryByText("Your conversations will appear here")).not.toBeInTheDocument();
  });

  it("forwards conversation intent to recent rows", async () => {
    const user = userEvent.setup();
    const onConversationIntent = vi.fn();
    render(
      <HomePane
        firstName="Karan"
        onSubmit={() => undefined}
        onConversationIntent={onConversationIntent}
        recents={[
          {
            id: "web-chat",
            title: "Create a PDF for my skills",
            channel: "web",
            occurredAt: "2026-05-26T06:30:00.000Z",
          },
        ]}
      />,
    );

    await user.hover(screen.getByRole("link", { name: /Create a PDF for my skills/i }));

    expect(onConversationIntent).toHaveBeenCalledWith("web-chat");
  });

  it("confirms before deleting a recent conversation", async () => {
    const user = userEvent.setup();
    const onDeleteConversation = vi.fn();
    render(
      <HomePane
        firstName="Karan"
        onSubmit={() => undefined}
        onDeleteConversation={onDeleteConversation}
        recents={[
          {
            id: "web-chat",
            title: "Create a PDF for my skills",
            channel: "web",
            occurredAt: "2026-05-26T06:30:00.000Z",
            now: new Date("2026-05-26T06:48:00.000Z"),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Conversation actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /Delete chat/i }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete conversation?")).toBeInTheDocument();
    expect(onDeleteConversation).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDeleteConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "web-chat", title: "Create a PDF for my skills" }),
    );
  });
});
