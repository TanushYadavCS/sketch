import { describe, expect, it } from "vitest";
import { parseCredentials, serializeCredentials } from "./sync-utils";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("connector credential serialization", () => {
  it("encrypts credentials when an encryption key is configured", () => {
    const stored = serializeCredentials({ type: "api_key", api_key: "secret" }, KEY);

    expect(stored.startsWith("enc:")).toBe(true);
    expect(stored).not.toContain("secret");
    expect(parseCredentials(stored, KEY)).toEqual({ type: "api_key", api_key: "secret" });
  });

  it("keeps backward compatibility with existing plaintext rows", () => {
    const stored = serializeCredentials({ type: "api_key", api_key: "secret" });

    expect(stored).toBe('{"type":"api_key","api_key":"secret"}');
    expect(parseCredentials(stored, KEY)).toEqual({ type: "api_key", api_key: "secret" });
  });
});
