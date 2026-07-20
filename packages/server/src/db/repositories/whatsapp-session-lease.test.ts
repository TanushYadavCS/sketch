import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import type { DB } from "../schema";
import { WhatsAppLeaseFenceError, createWhatsAppSessionLeaseRepository } from "./whatsapp-session-lease";

function owner(ownerToken: string) {
  return {
    ownerKind: "gateway" as const,
    ownerToken,
    gatewayHttpToken: `http-${ownerToken}`,
    hostId: "host-1",
    bootId: "boot-1",
    pid: 123,
    pidStartTime: "456",
    scriptHash: "script-hash",
    contractVersion: "1.0",
  };
}

describe("WhatsApp session lease repository on SQLite", () => {
  let directory: string;
  let sqlitePath: string;
  let db: Kysely<DB>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sketch-wa-lease-"));
    sqlitePath = join(directory, "lease.db");
    const raw = new Database(sqlitePath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
    await runMigrations(db, { quiet: true });
  }, 30000);

  afterEach(async () => {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  it("acquires once, takes over only after DB-clock staleness, increments the fence, and rejects zombie heartbeats", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    const first = await repo.acquire(owner("owner-a"));
    expect(first).toMatchObject({ acquired: true, lease: { owner_token: "owner-a", generation: 1 } });
    await expect(repo.acquire(owner("owner-b"))).resolves.toMatchObject({
      acquired: false,
      lease: { owner_token: "owner-a", generation: 1 },
    });

    await db
      .updateTable("whatsapp_session_lease")
      .set({ heartbeat_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", "default")
      .execute();
    await expect(repo.compareAndSwap("wrong-observed-token", owner("owner-b"))).resolves.toMatchObject({
      acquired: false,
      lease: { owner_token: "owner-a", generation: 1 },
    });
    await expect(repo.compareAndSwap("owner-a", owner("owner-b"))).resolves.toMatchObject({
      acquired: true,
      lease: { owner_token: "owner-b", generation: 2 },
    });
    await expect(repo.heartbeat("owner-a")).resolves.toBe(false);
    await expect(repo.heartbeat("owner-b", { markLive: true })).resolves.toBe(true);
  });

  it("uses a dedicated BEGIN IMMEDIATE connection and commits or rolls back auth writes behind the fence", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    const acquired = await repo.acquire(owner("owner-a"));
    const fence = { ownerToken: "owner-a", generation: acquired.lease?.generation ?? 0 };

    await repo.withLeaseFence(fence, async (executor) => {
      const contender = new Database(sqlitePath);
      contender.pragma("busy_timeout = 0");
      try {
        expect(() =>
          contender.prepare("UPDATE whatsapp_session_lease SET owner_token = 'owner-b' WHERE id = 'default'").run(),
        ).toThrow(/locked|busy/i);
      } finally {
        contender.close();
      }
      await executor.insertInto("whatsapp_creds").values({ id: "default", creds: "committed" }).execute();
    });
    await expect(
      db.selectFrom("whatsapp_creds").select("creds").where("id", "=", "default").executeTakeFirst(),
    ).resolves.toEqual({ creds: "committed" });

    await expect(
      repo.withLeaseFence(fence, async (executor) => {
        await executor.updateTable("whatsapp_creds").set({ creds: "rolled-back" }).execute();
        throw new Error("abort auth batch");
      }),
    ).rejects.toThrow("abort auth batch");
    await expect(
      db.selectFrom("whatsapp_creds").select("creds").where("id", "=", "default").executeTakeFirst(),
    ).resolves.toEqual({ creds: "committed" });

    const takeoverConnection = new Database(sqlitePath);
    try {
      takeoverConnection
        .prepare("UPDATE whatsapp_session_lease SET owner_token = ?, generation = generation + 1 WHERE id = ?")
        .run("owner-b", "default");
    } finally {
      takeoverConnection.close();
    }
    await expect(repo.withLeaseFence(fence, async () => undefined)).rejects.toBeInstanceOf(WhatsAppLeaseFenceError);
  });

  it("derives abrupt-disconnect time from the last DB-authoritative live heartbeat", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    const acquired = await repo.acquire(owner("owner-a"));
    const fence = { ownerToken: "owner-a", generation: acquired.lease?.generation ?? 0 };
    await repo.heartbeat("owner-a", { markLive: true });
    await expect(repo.deriveDisconnectedAt(fence)).resolves.toBe(true);
    const lease = await repo.get();
    expect(lease?.disconnected_at).toBe(lease?.last_live_at);
    await expect(repo.deriveDisconnectedAt(fence)).resolves.toBe(false);
  });

  it("persists each fenced connected transition before notification delivery", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    const acquired = await repo.acquire(owner("owner-connected"));
    const fence = { ownerToken: "owner-connected", generation: acquired.lease?.generation ?? 0 };
    await db
      .updateTable("whatsapp_session_lease")
      .set({ disconnected_at: "2026-07-17T10:00:00.000Z" })
      .where("id", "=", "default")
      .execute();

    await expect(repo.recordConnectedTransition(fence, 3, "2026-07-17T10:15:00.000Z")).resolves.toBe(true);
    await expect(repo.recordConnectedTransition(fence, 3, "2026-07-17T10:16:00.000Z")).resolves.toBe(false);
    await expect(
      db.selectFrom("whatsapp_connection_transitions").selectAll().executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      connection_key: "000000000001:000000000003",
      lease_generation: 1,
      socket_generation: 3,
      disconnected_at: "2026-07-17T10:00:00.000Z",
      connected_at: "2026-07-17T10:15:00.000Z",
      reconciled_at: null,
    });
    await expect(
      repo.recordConnectedTransition({ ownerToken: "stale-owner", generation: 1 }, 4, "2026-07-17T10:30:00.000Z"),
    ).rejects.toBeInstanceOf(WhatsAppLeaseFenceError);
  });

  it("leaves disconnected_at null when no live heartbeat exists", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    const acquired = await repo.acquire(owner("owner-a"));
    const fence = { ownerToken: "owner-a", generation: acquired.lease?.generation ?? 0 };
    await expect(repo.deriveDisconnectedAt(fence)).resolves.toBe(false);
    await expect(repo.get()).resolves.toMatchObject({ last_live_at: null, disconnected_at: null });
  });

  it("distinguishes heartbeat ownership loss from a database failure", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    await repo.acquire(owner("owner-a"));
    await expect(repo.heartbeat("zombie-owner")).resolves.toBe(false);
    await db.schema.dropTable("whatsapp_session_lease").execute();
    await expect(repo.heartbeat("owner-a")).rejects.toThrow();
  });

  it("releases ownership immediately while retaining the persisted HTTP token", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    const acquired = await repo.acquire(owner("owner-a"));
    const fence = { ownerToken: "owner-a", generation: acquired.lease?.generation ?? 0 };
    await repo.heartbeat("owner-a", { markLive: true });
    await repo.markDisconnected(fence);
    await expect(repo.release(fence)).resolves.toBe(true);
    await expect(repo.get()).resolves.toMatchObject({
      owner_token: "released:owner-a",
      gateway_http_token: "http-owner-a",
      heartbeat_at: "1970-01-01T00:00:00.000Z",
      last_live_at: expect.any(String),
      disconnected_at: expect.any(String),
    });
    await expect(repo.acquire(owner("owner-b"))).resolves.toMatchObject({
      acquired: true,
      lease: { owner_token: "owner-b", generation: 2, gateway_http_token: "http-owner-b" },
    });
  });

  it("releases after logout and clears history generation watermarks", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    const acquired = await repo.acquire(owner("owner-logout"));
    const fence = { ownerToken: "owner-logout", generation: acquired.lease?.generation ?? 0 };
    await repo.heartbeat("owner-logout", { markLive: true });
    await repo.markDisconnected(fence);

    await expect(repo.releaseAfterLogout(fence)).resolves.toBe(true);
    await expect(repo.get()).resolves.toMatchObject({
      owner_token: "released:owner-logout",
      last_live_at: null,
      disconnected_at: null,
    });
  });
});
