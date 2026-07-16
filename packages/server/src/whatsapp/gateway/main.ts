import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { proto } from "@whiskeysockets/baileys";
import { z } from "zod";
import { loadConfig, validateConfig } from "../../config";
import { createWhatsAppGroupRepository } from "../../db/repositories/whatsapp-groups";
import {
  WhatsAppLeaseFenceError,
  createWhatsAppSessionLeaseRepository,
} from "../../db/repositories/whatsapp-session-lease";
import { createLogger } from "../../logger";
import { createDbAuthState } from "../auth-store";
import { WhatsAppBot, type WhatsAppMessage } from "../bot";
import { WHATSAPP_FACADE_CONTRACT_VERSION } from "../facade-contract";
import { InProcessSocketFacade } from "../in-process-socket-facade";
import { WhatsAppGatewayCapture } from "./capture";
import { createWhatsAppGatewayDatabase } from "./database";
import { WhatsAppGatewayHeartbeat } from "./heartbeat";
import { WHATSAPP_GATEWAY_DEFAULT_PORT, WHATSAPP_GATEWAY_HOST, createWhatsAppGatewayHttpApp } from "./http-server";
import { loadBootId, loadHostId, loadPidStartTime } from "./identity";
import { whatsappGatewayReconnectDelayMs } from "./reconnect";
import { GatewaySocketFacade, type WhatsAppGatewaySocketState } from "./socket-facade";

export const WHATSAPP_GATEWAY_LOGGED_OUT_EXIT_CODE = 64;

const gatewayPortSchema = z.coerce.number().int().min(1).max(65_535).default(WHATSAPP_GATEWAY_DEFAULT_PORT);
const gatewayHttpTokenSchema = z.string().min(32);

function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function currentScriptHash(): Promise<string> {
  return createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex");
}

export async function runWhatsAppGateway(): Promise<void> {
  const config = loadConfig();
  validateConfig(config);
  const port = gatewayPortSchema.parse(process.env.WHATSAPP_GATEWAY_PORT);
  const logger = createLogger(config);
  const db = await createWhatsAppGatewayDatabase(config);
  const scriptHash = await currentScriptHash();
  const leaseRepository = createWhatsAppSessionLeaseRepository(db, {
    ...(config.DB_TYPE === "sqlite" ? { sqlitePath: config.SQLITE_PATH } : {}),
  });
  const observedLease = await leaseRepository.get();
  const configuredGatewayHttpToken = process.env.WHATSAPP_GATEWAY_HTTP_TOKEN
    ? gatewayHttpTokenSchema.parse(process.env.WHATSAPP_GATEWAY_HTTP_TOKEN)
    : null;
  const gatewayHttpToken =
    configuredGatewayHttpToken ?? observedLease?.gateway_http_token ?? randomBytes(32).toString("hex");
  const ownerToken = randomUUID();
  const acquired = await leaseRepository.acquire({
    ownerKind: "gateway",
    ownerToken,
    gatewayHttpToken,
    hostId: await loadHostId(config.DATA_DIR),
    bootId: await loadBootId(),
    pid: process.pid,
    pidStartTime: await loadPidStartTime(),
    scriptHash,
    contractVersion: WHATSAPP_FACADE_CONTRACT_VERSION,
  });
  if (!acquired.acquired || !acquired.lease) {
    logger.error({ ownerKind: acquired.lease?.owner_kind }, "WhatsApp gateway could not acquire the session lease");
    await db.destroy();
    process.exit(1);
  }

  const fence = { ownerToken, generation: acquired.lease.generation };
  await leaseRepository.deriveDisconnectedAt(fence);
  const recoveredLease = await leaseRepository.get();
  let initialSyncGeneration = recoveredLease?.last_live_at == null;
  let socketState: WhatsAppGatewaySocketState = "connecting";
  let terminating = false;
  let heartbeat: WhatsAppGatewayHeartbeat | null = null;
  let server: ReturnType<typeof serve> | null = null;
  let bot: WhatsAppBot | null = null;

  const terminate = async (
    code: number,
    releaseLease: boolean,
    reason: string,
    resetHistoryGeneration = false,
  ): Promise<void> => {
    if (terminating) return;
    terminating = true;
    heartbeat?.stop();
    logger.info({ code, reason }, "WhatsApp gateway stopping");
    try {
      await bot?.stop();
    } catch (error) {
      logger.warn({ error }, "WhatsApp gateway socket close failed");
    }
    if (releaseLease) {
      try {
        if (resetHistoryGeneration) {
          await leaseRepository.releaseAfterLogout(fence);
        } else {
          await leaseRepository.release(fence);
        }
      } catch (error) {
        logger.warn({ error }, "WhatsApp gateway lease release failed");
      }
    }
    if (server) {
      try {
        await closeServer(server);
      } catch (error) {
        logger.warn({ error }, "WhatsApp gateway HTTP server close failed");
      }
    }
    await db.destroy();
    process.exit(code);
  };

  const ownershipLost = (reason: string) => terminate(1, false, reason);
  const groupRepository = createWhatsAppGroupRepository(db);
  bot = new WhatsAppBot({
    db,
    logger,
    groupMetadataStore: groupRepository,
    watchdogEnabled: false,
    authStateFactory: () =>
      createDbAuthState(db, logger, {
        withWriteFence: (callback) => leaseRepository.withLeaseFence(fence, callback),
      }),
    getMessage: async (_key: proto.IMessageKey) => undefined,
    reconnectDelayMs: whatsappGatewayReconnectDelayMs,
    onConnectionOpen: async () => {
      if (terminating) return;
      try {
        await leaseRepository.deriveDisconnectedAt(fence);
      } catch (error) {
        logger.warn({ error }, "WhatsApp gateway could not derive the reconnect watermark");
      }
      socketState = "connected";
      await heartbeat?.tick();
    },
    onConnectionClose: async () => {
      if (terminating) return;
      const wasConnected = socketState === "connected";
      socketState = "disconnected";
      try {
        const owned = await leaseRepository.markDisconnected(fence);
        if (!owned) {
          await ownershipLost("socket close was fenced out by a newer owner");
          return;
        }
      } catch (error) {
        logger.warn({ error }, "WhatsApp gateway could not stamp the disconnect watermark");
      }
      if (wasConnected) initialSyncGeneration = false;
    },
    onLoggedOut: async () => {
      socketState = "logged-out";
      await terminate(WHATSAPP_GATEWAY_LOGGED_OUT_EXIT_CODE, true, "WhatsApp account logged out", true);
    },
  });

  const inProcessFacade = new InProcessSocketFacade(bot, logger, async () => {
    heartbeat?.stop();
    socketState = "logged-out";
    initialSyncGeneration = true;
    if (!(await leaseRepository.resetHistoryGeneration(fence))) throw new WhatsAppLeaseFenceError();
    heartbeat?.start();
  });
  const wake = async (): Promise<void> => {
    try {
      const response = await fetch(`http://${WHATSAPP_GATEWAY_HOST}:${config.PORT}/internal/whatsapp/wake`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gatewayHttpToken}` },
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
    } catch {}
  };
  const capture = new WhatsAppGatewayCapture({
    db,
    logger,
    stagingDir: join(config.DATA_DIR, "wa-staging"),
    maxFileBytes: config.MAX_FILE_SIZE_MB * 1024 * 1024,
    getSocket: () => bot?.socket ?? null,
    rememberMessage: (params) => inProcessFacade.rememberMessage(params),
    isInitialSyncGeneration: () => initialSyncGeneration,
    wake,
  });
  bot.onMessage((message) => capture.captureMessage(message));
  bot.onHistoryMessages((messages, metadata) => capture.captureHistory(messages, metadata));
  if (process.env.WHATSAPP_GATEWAY_TEST_FAKE_SOCKET === "1" && typeof process.send === "function") {
    process.on("message", (input) => {
      if (!input || typeof input !== "object" || !("type" in input) || input.type !== "capture-message") return;
      if (!("message" in input)) return;
      void capture.captureMessage(input.message as WhatsAppMessage);
    });
  }

  const facade = new GatewaySocketFacade({
    delegate: inProcessFacade,
    stagingDir: join(config.DATA_DIR, "wa-staging"),
    maxFileBytes: config.MAX_FILE_SIZE_MB * 1024 * 1024,
    logger,
    socketState: () => socketState,
    queueDepth: () => capture.queueDepth(),
    insertFailures: () => capture.insertFailures,
    scriptHash,
    shutdown: () => terminate(0, true, "authenticated shutdown requested"),
  });
  const app = createWhatsAppGatewayHttpApp({ token: gatewayHttpToken, facade, logger });
  server = serve({ fetch: app.fetch, hostname: WHATSAPP_GATEWAY_HOST, port });
  heartbeat = new WhatsAppGatewayHeartbeat({
    heartbeat: (markLive) => leaseRepository.heartbeat(ownerToken, { markLive }),
    isSocketHealthy: () => socketState === "connected",
    onOwnershipLost: ownershipLost,
    logger,
  });
  heartbeat.start();

  process.on("SIGINT", () => void terminate(0, true, "SIGINT"));
  process.on("SIGTERM", () => void terminate(0, true, "SIGTERM"));
  process.on("unhandledRejection", (error) => {
    if (error instanceof WhatsAppLeaseFenceError) {
      void ownershipLost("fenced auth write rejected the gateway owner");
      return;
    }
    logger.error({ error }, "Unhandled WhatsApp gateway rejection");
    void terminate(1, false, "unhandled rejection");
  });

  const connected = await bot.start();
  if (!connected) socketState = "disconnected";
  logger.info({ host: WHATSAPP_GATEWAY_HOST, port, socketState }, "WhatsApp gateway ready");
}

await runWhatsAppGateway();
