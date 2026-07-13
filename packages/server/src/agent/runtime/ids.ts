import { randomBytes } from "node:crypto";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Creates an RFC 9562 UUID v7 suitable for first-turn AI SDK session ids. */
export function createAgentRuntimeSessionId(nowMs = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(nowMs);

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return `${hex(bytes.subarray(0, 4))}-${hex(bytes.subarray(4, 6))}-${hex(bytes.subarray(6, 8))}-${hex(
    bytes.subarray(8, 10),
  )}-${hex(bytes.subarray(10, 16))}`;
}
