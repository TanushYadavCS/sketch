import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "skp_";
const TOKEN_BYTES = 32;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function toBase62(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  if (value === 0n) return BASE62_ALPHABET[0];

  let output = "";
  const base = BigInt(BASE62_ALPHABET.length);
  while (value > 0n) {
    const index = Number(value % base);
    output = BASE62_ALPHABET[index] + output;
    value /= base;
  }
  return output;
}

export function generateApiToken(): string {
  return `${TOKEN_PREFIX}${toBase62(randomBytes(TOKEN_BYTES)).padStart(43, BASE62_ALPHABET[0])}`;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isSketchPat(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function getApiTokenDisplayPrefix(token: string): string {
  return token.slice(0, 8);
}
