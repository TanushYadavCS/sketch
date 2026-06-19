import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./chat-input";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const originalMediaDevices = navigator.mediaDevices;

describe("ChatInput", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
  });

  it("renders input affordances", () => {
    render(<ChatInput onSubmit={() => undefined} />);

    expect(screen.getByLabelText("Attach a file")).toBeInTheDocument();
    expect(screen.getByLabelText("Record voice")).toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Sketch")).toBeInTheDocument();
  });

  it("uses the light-mode text color as the enabled send button background", () => {
    render(<ChatInput initialValue="Hello" onSubmit={() => undefined} />);

    const sendButton = screen.getByLabelText("Send message");
    expect(sendButton).toBeEnabled();
    expect(sendButton).toHaveClass("bg-foreground", "text-background");
    expect(sendButton.className).toContain("shadow-[0_2px_8px_rgba(0,0,0,0.16),0_0_18px_rgba(0,0,0,0.08)]");
    expect(sendButton.className).toContain("dark:bg-brand-accent");
    expect(sendButton.className).toContain("dark:text-black");
    expect(sendButton.className).toContain("dark:shadow-[0_2px_8px_rgba(254,237,1,0.5)");
  });

  it("changes the activity detail mode from the prompt input menu", async () => {
    const user = userEvent.setup();
    const onRendererChange = vi.fn();

    render(
      <ChatInput
        rendererValue="friendly"
        rendererOptions={[
          { value: "off", label: "Off" },
          { value: "friendly", label: "Friendly" },
          { value: "technical", label: "Technical" },
        ]}
        onRendererChange={onRendererChange}
      />,
    );

    await user.click(screen.getByLabelText("Progress updates: Friendly"));
    expect(screen.getByText("Progress updates")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: /Technical/ }));

    expect(onRendererChange).toHaveBeenCalledWith("technical");
  });

  it("shows a neutral pause control while the prompt is unavailable during a run", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onSubmit = vi.fn();

    render(
      <ChatInput
        running
        rendererValue="friendly"
        rendererOptions={[
          { value: "off", label: "Off" },
          { value: "friendly", label: "Friendly" },
          { value: "technical", label: "Technical" },
        ]}
        onRendererChange={() => undefined}
        onStop={onStop}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByPlaceholderText("Sketch is working...")).toBeDisabled();
    expect(screen.getByLabelText("Progress updates: Friendly")).toBeDisabled();
    const pauseButton = screen.getByLabelText("Pause Sketch");
    expect(pauseButton).toHaveClass("bg-muted/80", "text-muted-foreground");
    expect(pauseButton.className).not.toContain("dark:bg-brand-accent");

    await user.click(pauseButton);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows recording and transcription state while appending transcribed text", async () => {
    const user = userEvent.setup();
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    });
    const transcription = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(transcription.promise);
    vi.stubGlobal("fetch", fetchMock);

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn((mimeType: string) => mimeType === "audio/mp4");
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
        this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    render(<ChatInput onSubmit={() => undefined} />);

    await user.click(screen.getByLabelText("Record voice"));
    expect(await screen.findByPlaceholderText("Recording... click stop when done")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Stop recording"));
    expect(await screen.findByPlaceholderText("Transcribing audio...")).toBeInTheDocument();
    expect(screen.queryByText("Transcribing audio...")).not.toBeInTheDocument();
    const voiceButton = screen.getByLabelText("Record voice");
    expect(voiceButton).toHaveAttribute("aria-busy", "true");
    const spinner = voiceButton.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
    expect(spinner?.getAttribute("style")).toContain("border-top-color: var(--brand-accent)");

    const form = fetchMock.mock.calls[0][1].body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("recording.m4a");
    expect(file.type).toBe("audio/mp4");

    transcription.resolve({ ok: true, status: 200, json: async () => ({ text: "hello transcript" }) } as Response);
    await waitFor(() => expect(screen.getByLabelText("Message Sketch")).toHaveValue("hello transcript"));
    expect(stopTrack).toHaveBeenCalled();
  });

  it("discards active recordings during unmount cleanup", async () => {
    const user = userEvent.setup();
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn((mimeType: string) => mimeType === "audio/mp4");
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
        this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const view = render(<ChatInput onSubmit={() => undefined} />);

    await user.click(screen.getByLabelText("Record voice"));
    expect(await screen.findByPlaceholderText("Recording... click stop when done")).toBeInTheDocument();

    view.unmount();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
  });
});
