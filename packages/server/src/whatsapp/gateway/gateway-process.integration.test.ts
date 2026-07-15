import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../config";
import { createDatabase } from "../../db/index";
import { runMigrations } from "../../db/migrate";
import {
  createWhatsAppEventKey,
  createWhatsAppInboundEventsRepository,
} from "../../db/repositories/whatsapp-inbound-events";
import type { DB } from "../../db/schema";
import { ChannelQueue } from "../../queue";
import { createTestConfig, createTestLogger } from "../../test-utils";
import type { WhatsAppAdapterHandlers } from "../adapter";
import type { WhatsAppMessage } from "../bot";
import { WhatsAppInboundConsumer } from "../inbound-consumer";
import { WhatsAppGatewaySupervisor } from "./supervisor";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const gatewayMain = fileURLToPath(new URL("./main.ts", import.meta.url));

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a gateway test port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}

async function waitFor<T>(operation: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw lastError ?? new Error("Timed out waiting for gateway integration state");
}

function fakeMessage(id: string): WhatsAppMessage {
  const jid = "15551234567@s.whatsapp.net";
  return {
    type: "dm",
    text: `message-${id}`,
    jid,
    messageId: id,
    pushName: "Roopak",
    phoneNumber: "+15551234567",
    rawMessage: {
      key: { remoteJid: jid, id, fromMe: false },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: `message-${id}` },
      pushName: "Roopak",
    },
  };
}

function childOf(supervisor: WhatsAppGatewaySupervisor): ChildProcess | null {
  return (supervisor as unknown as { child: ChildProcess | null }).child;
}

async function sendFakeMessage(supervisor: WhatsAppGatewaySupervisor, message: WhatsAppMessage): Promise<void> {
  const child = await waitFor(async () => childOf(supervisor));
  if (!child.send) throw new Error("Gateway test subprocess has no IPC channel");
  const send = child.send.bind(child);
  await new Promise<void>((resolveSend, reject) => {
    send({ type: "capture-message", message }, (error) => (error ? reject(error) : resolveSend()));
  });
}

function handlersForQueue(queue: ChannelQueue, onDispatch: () => void): WhatsAppAdapterHandlers {
  return {
    captureQueuedMessage: async (_message, params) =>
      params.commitCapture ? params.commitCapture(async () => null) : null,
    dispatchCapturedMessage: async (_message, _capture, hooks) =>
      queue.enqueue(async () => {
        await hooks.onRunStart();
        onDispatch();
      }),
    handleHistoryMessages: async () => ({ persisted: 0, skippedOld: 0, skippedDup: 0 }),
  };
}

describe("real WhatsApp gateway subprocess", () => {
  let directory: string;
  let config: Config;
  let db: Kysely<DB>;
  let supervisor: WhatsAppGatewaySupervisor | null;
  let consumer: WhatsAppInboundConsumer | null;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sketch-wa-process-"));
    config = createTestConfig({
      SQLITE_PATH: join(directory, "gateway.db"),
      DATA_DIR: join(directory, "data"),
      WHATSAPP_RUNTIME_MODE: "gateway",
      WHATSAPP_GATEWAY_PORT: await availablePort(),
      PORT: await availablePort(),
    });
    db = await createDatabase(config);
    await runMigrations(db, { quiet: true });
    supervisor = new WhatsAppGatewaySupervisor({
      db,
      config,
      logger: createTestLogger(),
      gatewayScriptPath: gatewayMain,
      nodeArgs: [tsxCli],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        DB_TYPE: "sqlite",
        SQLITE_PATH: config.SQLITE_PATH,
        DATA_DIR: config.DATA_DIR,
        PORT: String(config.PORT),
        LOG_LEVEL: "error",
        WHATSAPP_RUNTIME_MODE: "gateway",
        WHATSAPP_GATEWAY_TEST_FAKE_SOCKET: "1",
      },
    });
    consumer = null;
  });

  afterEach(async () => {
    await consumer?.stop().catch(() => undefined);
    await supervisor?.shutdown().catch(() => undefined);
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  async function pendingRow(id: string) {
    const message = fakeMessage(id);
    await sendFakeMessage(supervisor as WhatsAppGatewaySupervisor, message);
    const eventKey = createWhatsAppEventKey(message.jid, id, false);
    return waitFor(() =>
      db.selectFrom("whatsapp_inbound_events").selectAll().where("event_key", "=", eventKey).executeTakeFirst(),
    );
  }

  async function drainToQueue(expectedId: number): Promise<number> {
    let dispatched = 0;
    const queue = new ChannelQueue();
    consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "data", "wa-staging"),
      handlers: handlersForQueue(queue, () => {
        dispatched += 1;
      }),
    });
    consumer.start();
    await consumer.wake();
    await waitFor(async () => (dispatched === 1 ? dispatched : null));
    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select("status")
      .where("id", "=", expectedId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("consumed");
    return dispatched;
  }

  it("captures a fake-socket message durably and dispatches it through a ChannelQueue", async () => {
    await supervisor?.start();
    const row = await pendingRow("end-to-end");
    await expect(drainToQueue(row.id)).resolves.toBe(1);
  }, 30_000);

  it("respawns after SIGKILL without losing an already captured row", async () => {
    const facade = await supervisor?.start();
    const row = await pendingRow("kill-nine");
    const firstPid = childOf(supervisor as WhatsAppGatewaySupervisor)?.pid;
    childOf(supervisor as WhatsAppGatewaySupervisor)?.kill("SIGKILL");
    await waitFor(async () => {
      const nextPid = childOf(supervisor as WhatsAppGatewaySupervisor)?.pid;
      return nextPid && nextPid !== firstPid ? nextPid : null;
    });
    await waitFor(async () => facade?.health());
    await waitFor(async () => ((supervisor as unknown as { restarting: boolean }).restarting ? null : true));
    await expect(drainToQueue(row.id)).resolves.toBe(1);
  }, 30_000);

  it("adopts the surviving gateway on app restart and drains pending rows", async () => {
    await supervisor?.start();
    const row = await pendingRow("app-restart");
    const leaseBefore = await createWhatsAppInboundEventsRepository(db).findByEventKey(row.event_key ?? "");
    expect(leaseBefore?.status).toBe("pending");
    const firstSupervisor = supervisor as WhatsAppGatewaySupervisor;
    (firstSupervisor as unknown as { stopHealthPolling(): void }).stopHealthPolling();
    (firstSupervisor as unknown as { stopping: boolean }).stopping = true;
    const restartedAppSupervisor = new WhatsAppGatewaySupervisor({
      db,
      config,
      logger: createTestLogger(),
      gatewayScriptPath: gatewayMain,
      nodeArgs: [tsxCli],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    supervisor = restartedAppSupervisor;
    await restartedAppSupervisor.start();
    expect(childOf(restartedAppSupervisor)).toBeNull();
    await expect(drainToQueue(row.id)).resolves.toBe(1);
  }, 30_000);
});
