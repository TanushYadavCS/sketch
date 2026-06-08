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
