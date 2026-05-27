import { describe, expect, it } from "vitest";
import { audioFormatFromPath } from "./openrouter";

describe("audioFormatFromPath", () => {
  it("uses whitelisted extensions", () => {
    expect(audioFormatFromPath("/tmp/VOICE.AAC")).toBe("aac");
    expect(audioFormatFromPath("/tmp/VOICE.OGG")).toBe("ogg");
    expect(audioFormatFromPath("/tmp/voice.oga")).toBe("ogg");
  });

  it("uses MIME type for generic file names", () => {
    expect(audioFormatFromPath("/tmp/voice.bin", { mimeType: "audio/aac" })).toBe("aac");
    expect(audioFormatFromPath("/tmp/voice.bin", { mimeType: "audio/x-aac" })).toBe("aac");
    expect(audioFormatFromPath("/tmp/voice.bin", { mimeType: "audio/ogg; codecs=opus" })).toBe("ogg");
    expect(audioFormatFromPath("/tmp/voice.bin", { mimeType: "audio/mp4" })).toBe("m4a");
  });

  it("sniffs common audio headers when MIME and extension are not useful", () => {
    expect(audioFormatFromPath("/tmp/voice.bin", { data: Buffer.from("ID3audio") })).toBe("mp3");
    expect(audioFormatFromPath("/tmp/voice.bin", { data: Buffer.from("OggSaudio") })).toBe("ogg");
    expect(
      audioFormatFromPath("/tmp/voice.bin", {
        data: Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]),
      }),
    ).toBe("m4a");
  });

  it("does not pass arbitrary extensions through as formats", () => {
    expect(audioFormatFromPath("/tmp/voice.bin")).toBe("mp3");
    expect(audioFormatFromPath("/tmp/voice.custom")).toBe("mp3");
  });
});
