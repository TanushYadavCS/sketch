import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./encryption";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WRONG_KEY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("encrypt / decrypt", () => {
  it("round-trips a normal string", () => {
    const plaintext = "xoxb-test-token";
    const ciphertext = encrypt(plaintext, TEST_KEY);
    expect(decrypt(ciphertext, TEST_KEY)).toBe(plaintext);
  });

  it("encrypted output starts with enc: prefix", () => {
    const ciphertext = encrypt("hello", TEST_KEY);
    expect(ciphertext.startsWith("enc:")).toBe(true);
  });

  it("decrypt() with wrong key throws", () => {
    const ciphertext = encrypt("secret-value", TEST_KEY);
    expect(() => decrypt(ciphertext, WRONG_KEY)).toThrow();
  });

  it("round-trips an empty string", () => {
    const ciphertext = encrypt("", TEST_KEY);
    expect(ciphertext.startsWith("enc:")).toBe(true);
    expect(decrypt(ciphertext, TEST_KEY)).toBe("");
  });

  it("decrypt() returns plaintext as-is when no enc: prefix", () => {
    expect(decrypt("some-plain-value", TEST_KEY)).toBe("some-plain-value");
  });

  it("two encryptions of the same plaintext produce different ciphertexts", () => {
    const a = encrypt("same-input", TEST_KEY);
    const b = encrypt("same-input", TEST_KEY);
    expect(a).not.toBe(b);
  });
});
