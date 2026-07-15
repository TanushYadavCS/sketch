import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils";
import type { WhatsAppSocketFacade } from "../facade-contract";
import type { InProcessMessageReferenceStore } from "../in-process-socket-facade";
import { GatewaySocketFacade } from "./socket-facade";

function delegate(send: WhatsAppSocketFacade["send"]): WhatsAppSocketFacade & InProcessMessageReferenceStore {
  return {
    send,
    rememberMessage: () => undefined,
    sendComposing: async () => undefined,
    react: async () => ({ ok: true }),
    downloadMedia: async () => null,
    groupMetadata: async () => null,
    syncAllGroups: async () => ({ synced: 0 }),
    resolveLid: async () => null,
    pairing: {
      startQr: async () => undefined,
      status: async () => ({ connected: false, phoneNumber: null }),
      cancel: async () => undefined,
      logout: async () => undefined,
    },
    shutdown: async () => undefined,
    health: async () => ({
      socketState: "disconnected",
      queueDepth: 0,
      insertFailures: 0,
      uptime: 0,
      scriptHash: "delegate",
      contractVersion: "1.0",
    }),
  };
}

describe("GatewaySocketFacade", () => {
  it("serializes and replays the complete send DTO by idempotency key", async () => {
    let sends = 0;
    const facade = new GatewaySocketFacade({
      delegate: delegate(async () => {
        sends += 1;
        return {
          providerMessageId: "wamid.sent",
          providerConversationId: "group@g.us",
          providerTimestamp: "2026-07-15T08:27:00.000Z",
          rawProviderPayload: { key: { id: "wamid.sent" } },
        };
      }),
      stagingDir: "/tmp/wa-staging",
      maxFileBytes: 1024,
      logger: createTestLogger(),
      socketState: () => "connected",
      queueDepth: async () => 0,
      insertFailures: () => 0,
      scriptHash: "hash",
      shutdown: async () => undefined,
    });
    const opts = { idempotencyKey: "idempotent-send" };
    const first = await facade.send("group@g.us", { kind: "text", text: "hello" }, opts);
    const second = await facade.send("group@g.us", { kind: "text", text: "hello" }, opts);
    expect(sends).toBe(1);
    expect(first).toEqual({
      providerMessageId: "wamid.sent",
      providerConversationId: "group@g.us",
      providerTimestamp: "2026-07-15T08:27:00.000Z",
    });
    expect(second).toEqual(first);
  });

  it("does not cache a null send result while the socket is down", async () => {
    let sends = 0;
    const facade = new GatewaySocketFacade({
      delegate: delegate(async () => {
        sends += 1;
        return null;
      }),
      stagingDir: "/tmp/wa-staging",
      maxFileBytes: 1024,
      logger: createTestLogger(),
      socketState: () => "disconnected",
      queueDepth: async () => 0,
      insertFailures: () => 0,
      scriptHash: "hash",
      shutdown: async () => undefined,
    });
    const opts = { idempotencyKey: "socket-down" };
    await expect(facade.send("group@g.us", { kind: "text", text: "hello" }, opts)).resolves.toBeNull();
    await expect(facade.send("group@g.us", { kind: "text", text: "hello" }, opts)).resolves.toBeNull();
    expect(sends).toBe(2);
  });

  it("forces facade media downloads into the staging root with the gateway size cap", async () => {
    let received: Parameters<WhatsAppSocketFacade["downloadMedia"]>[0] | null = null;
    const base = delegate(async () => null);
    base.downloadMedia = async (ref) => {
      received = ref;
      return {
        stagedPath: "/tmp/wa-staging/media.bin",
        mime: "application/octet-stream",
        size: 10,
        sha256: "a".repeat(64),
      };
    };
    const facade = new GatewaySocketFacade({
      delegate: base,
      stagingDir: "/tmp/wa-staging",
      maxFileBytes: 1024,
      logger: createTestLogger(),
      socketState: () => "connected",
      queueDepth: async () => 0,
      insertFailures: () => 0,
      scriptHash: "hash",
      shutdown: async () => undefined,
    });
    await facade.downloadMedia({
      messageRef: { kind: "eventKey", value: "event" },
      destinationDir: "/tmp/untrusted",
      maxFileBytes: 2048,
    });
    expect(received).toMatchObject({ destinationDir: "/tmp/wa-staging", maxFileBytes: 1024 });
  });
});
