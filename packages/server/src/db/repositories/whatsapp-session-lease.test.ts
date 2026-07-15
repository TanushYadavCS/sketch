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
  });

  it("distinguishes heartbeat ownership loss from a database failure", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db, { sqlitePath });
    await repo.acquire(owner("owner-a"));
    await expect(repo.heartbeat("zombie-owner")).resolves.toBe(false);
    await db.schema.dropTable("whatsapp_session_lease").execute();
    await expect(repo.heartbeat("owner-a")).rejects.toThrow();
  });
});
