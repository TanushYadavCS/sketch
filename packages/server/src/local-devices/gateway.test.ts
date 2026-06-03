import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { LocalDeviceRow } from "../db/repositories/local-devices";
import { createTestLogger } from "../test-utils";
import { LocalDeviceGateway } from "./gateway";

const USER_ID = "user-1";
const DEVICE_ID = "device-1";

function createDeviceRow(): LocalDeviceRow {
  return {
    id: DEVICE_ID,
    user_id: USER_ID,
    name: "Test Mac",
    platform: "macos",
    token_hash: "hash",
    prefix: "skl_test",
    status: "online",
    last_seen_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    revoked_at: null,
  };
}

function createGateway(socket: { readyState: number; send: (data: string, cb: (err?: Error) => void) => void }) {
  const repo = {
    recordToolCall: vi.fn(async (input) => ({ id: "call-1", ...input })),
  };
  const gateway = new LocalDeviceGateway(repo as never, createTestLogger());
  const row = createDeviceRow();
  (
    gateway as unknown as {
      connections: Map<string, { row: LocalDeviceRow; socket: typeof socket; connectedAt: number }>;
    }
  ).connections.set(DEVICE_ID, { row, socket, connectedAt: Date.now() });
  return { gateway, repo };
}

describe("LocalDeviceGateway", () => {
  it("closes unmatched upgrade sockets", () => {
    const server = new EventEmitter();
    const socket = {
      write: vi.fn(),
      destroy: vi.fn(),
    };
    const { gateway } = createGateway({
      readyState: 1,
      send: () => {},
    });

    gateway.attach(server as never);
    server.emit("upgrade", { url: "/not-local-devices" }, socket, Buffer.alloc(0));

    expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("audits local command attempts when WebSocket send fails", async () => {
    const sendError = new Error("send failed");
    const { gateway, repo } = createGateway({
      readyState: 1,
      send: (_data, cb) => cb(sendError),
    });

    await expect(gateway.invoke(USER_ID, { command: "pwd", cwd: "/tmp" })).rejects.toThrow("send failed");

    expect(repo.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        userId: USER_ID,
        toolName: "local_run_command",
        command: "pwd",
        cwd: "/tmp",
        success: false,
        exitCode: null,
        timedOut: false,
        errorMessage: "send failed",
      }),
    );
  });

  it("audits pending local command attempts when the device disconnects", async () => {
    const { gateway, repo } = createGateway({
      readyState: 1,
      send: () => {},
    });

    const invocation = gateway.invoke(USER_ID, { command: "sleep 10" });
    await vi.waitFor(() => {
      expect(
        (
          gateway as unknown as {
            pending: Map<string, unknown>;
          }
        ).pending.size,
      ).toBe(1);
    });

    (
      gateway as unknown as {
        rejectPending: (deviceId: string, reason: string) => void;
      }
    ).rejectPending(DEVICE_ID, "Local device disconnected");

    await expect(invocation).rejects.toThrow("Local device disconnected");
    expect(repo.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        userId: USER_ID,
        toolName: "local_run_command",
        command: "sleep 10",
        success: false,
        exitCode: null,
        timedOut: false,
        errorMessage: "Local device disconnected",
      }),
    );
  });
});
