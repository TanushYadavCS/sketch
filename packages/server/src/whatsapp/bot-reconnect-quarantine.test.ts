import { DisconnectReason } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { WhatsAppBot } from "./bot";

const HOUR_MS = 60 * 60_000;

function createConnectionSocket() {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  return {
    socket: {
      ev: {
        on: (event: string, handler: (payload: unknown) => Promise<void>) => {
          handlers.set(event, handler);
        },
      },
      end: vi.fn(),
      /**
       * Present from construction for any paired account — this is the field the old sensor read,
       * so a fake without it would let these tests pass against the very bug they exist to catch.
       */
      user: { id: "919876543210:12@s.whatsapp.net" },
    },
    emit: async (payload: unknown) => handlers.get("connection.update")?.(payload),
  };
}

describe("WhatsApp reconnect backoff and quarantine", () => {
  let db: Kysely<DB>;
  const bots: WhatsAppBot[] = [];

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("whatsapp_creds")
      .values({ id: "default", creds: JSON.stringify({ me: { id: "919876543210:12@s.whatsapp.net" } }) })
      .execute();
  });

  afterEach(async () => {
    for (const bot of bots) await bot.stop();
    bots.length = 0;
    await db.destroy();
  });

  function createBot() {
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      watchdogEnabled: false,
      authStateFactory: async () =>
        ({
          state: { creds: {}, keys: {} },
          saveCreds: vi.fn().mockResolvedValue(undefined),
          clearCreds: vi.fn().mockResolvedValue(undefined),
        }) as never,
    });
    bots.push(bot);
    return bot;
  }

  function attach(bot: WhatsAppBot, connection: ReturnType<typeof createConnectionSocket>, generation: number) {
    const internals = bot as unknown as {
      sock: unknown;
      activeSocketGeneration: number;
      registerConnectionHandler: (socket: unknown, authState: unknown, generation: number) => void;
    };
    internals.sock = connection.socket;
    internals.activeSocketGeneration = generation;
    internals.registerConnectionHandler(
      connection.socket,
      { clearCreds: vi.fn().mockResolvedValue(undefined) },
      generation,
    );
  }

  /** Drives `times` failed closes, each on its own generation, as a real reconnect loop would. */
  async function driveCloses(bot: WhatsAppBot, statusCode: number | undefined, times: number) {
    for (let generation = 1; generation <= times; generation += 1) {
      const connection = createConnectionSocket();
      attach(bot, connection, generation);
      (bot as unknown as { reconnectTimer: unknown }).reconnectTimer = null;
      await connection.emit({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode }, message: "refused" } },
      });
    }
  }

  /**
   * The sensor at the heart of the incident. `sock.user` is a getter over persisted credentials,
   * so it reported this exact tenant as connected for eight and a half hours while nothing worked.
   */
  it("reports a socket that never opened as disconnected", async () => {
    const bot = createBot();
    const connection = createConnectionSocket();
    attach(bot, connection, 1);

    await connection.emit({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 405 } } },
    });

    expect(bot.isConnected).toBe(false);
    /** Still paired, though — the number is on file and must not be offered a fresh QR. */
    await expect(bot.isPaired()).resolves.toBe(true);
  });

  it("reports a live socket as connected", async () => {
    const bot = createBot();
    const connection = createConnectionSocket();
    attach(bot, connection, 1);

    await connection.emit({ connection: "open" });

    expect(bot.isConnected).toBe(true);
  });

  /** The central guarantee: sustained failure slows down, it does not delete the session. */
  it("pauses for an hour after sustained failures without deleting credentials", async () => {
    const bot = createBot();

    await driveCloses(bot, 405, 5);

    const pausedUntil = bot.reconnectPausedUntil;
    expect(pausedUntil).not.toBeNull();
    const remainingMs = Date.parse(pausedUntil as string) - Date.now();
    expect(remainingMs).toBeGreaterThan(HOUR_MS - 60_000);
    expect(remainingMs).toBeLessThanOrEqual(HOUR_MS);

    const creds = await db.selectFrom("whatsapp_creds").selectAll().execute();
    expect(creds).toHaveLength(1);
    await expect(bot.isPaired()).resolves.toBe(true);
  });

  it("keeps retrying on the ordinary curve before the threshold", async () => {
    const bot = createBot();

    await driveCloses(bot, 405, 4);

    expect(bot.reconnectPausedUntil).toBeNull();
  });

  /**
   * A quiet tenant closes on the watchdog every 30 minutes. Counting those would pause a perfectly
   * healthy connection after a couple of idle hours.
   */
  it("does not count a self-inflicted watchdog close", async () => {
    const bot = createBot();

    for (let generation = 1; generation <= 6; generation += 1) {
      const connection = createConnectionSocket();
      attach(bot, connection, generation);
      (bot as unknown as { intentionalCloseGeneration: number | null }).intentionalCloseGeneration = generation;
      (bot as unknown as { reconnectTimer: unknown }).reconnectTimer = null;
      await connection.emit({ connection: "close", lastDisconnect: undefined });
    }

    expect(bot.reconnectPausedUntil).toBeNull();
  });

  it("lifts the pause as soon as a connection succeeds", async () => {
    const bot = createBot();
    await driveCloses(bot, 405, 5);
    expect(bot.reconnectPausedUntil).not.toBeNull();

    const recovered = createConnectionSocket();
    attach(bot, recovered, 10);
    await recovered.emit({ connection: "open" });

    expect(bot.reconnectPausedUntil).toBeNull();
    expect(bot.isConnected).toBe(true);
  });

  /** Otherwise a freshly re-paired tenant inherits the dead session's pause and goes dark again. */
  it("lifts the pause on disconnect so a re-paired tenant stays back", async () => {
    const bot = createBot();
    await driveCloses(bot, 405, 5);

    await bot.disconnect();

    expect(bot.reconnectPausedUntil).toBeNull();
    expect(bot.isConnected).toBe(false);
  });

  /**
   * Pairing sockets close through the pairing listener rather than the reconnect handler. Missing
   * that path left liveness stuck true after a drop — the same dishonest state, reintroduced by
   * the very change meant to remove it.
   */
  it("drops liveness when a paired socket closes", async () => {
    const bot = createBot();
    const internals = bot as unknown as { socketLive: boolean };
    internals.socketLive = true;

    await bot.stop();

    expect(bot.isConnected).toBe(false);
  });

  /** A real logout is the one case where the credentials genuinely have to go. */
  it("still clears credentials on a real logout", async () => {
    const bot = createBot();
    const clearCreds = vi.fn().mockResolvedValue(undefined);
    const connection = createConnectionSocket();
    const internals = bot as unknown as {
      sock: unknown;
      activeSocketGeneration: number;
      registerConnectionHandler: (socket: unknown, authState: unknown, generation: number) => void;
    };
    internals.sock = connection.socket;
    internals.activeSocketGeneration = 1;
    internals.registerConnectionHandler(connection.socket, { clearCreds }, 1);

    await connection.emit({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });

    expect(clearCreds).toHaveBeenCalledOnce();
  });
});
