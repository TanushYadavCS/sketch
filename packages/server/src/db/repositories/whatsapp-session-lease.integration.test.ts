import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb, getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { WhatsAppLeaseFenceError, createWhatsAppSessionLeaseRepository } from "./whatsapp-session-lease";

function owner(ownerToken: string) {
  return {
    ownerKind: "gateway" as const,
    ownerToken,
    gatewayHttpToken: `http-${ownerToken}`,
    hostId: "host-pg",
    bootId: "boot-pg",
    pid: 321,
    pidStartTime: "654",
    scriptHash: "pg-script-hash",
    contractVersion: "1.0",
  };
}

describe("WhatsApp session lease repository on shared Postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("uses DB-clock CAS takeover and token-conditional heartbeat", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db);
    await expect(repo.acquire(owner("owner-a"))).resolves.toMatchObject({
      acquired: true,
      lease: { owner_token: "owner-a", generation: 1 },
    });
    await expect(repo.acquire(owner("owner-b"))).resolves.toMatchObject({ acquired: false });
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

  it("releases to the epoch sentinel and permits CAS takeover through the Postgres timestamptz cast", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db);
    const acquired = await repo.acquire(owner("owner-release"));
    const fence = { ownerToken: "owner-release", generation: acquired.lease?.generation ?? 0 };
    await expect(repo.release(fence)).resolves.toBe(true);
    const released = await repo.get();
    expect(released?.owner_token).toBe("released:owner-release");
    await expect(repo.compareAndSwap("released:owner-release", owner("owner-after-release"))).resolves.toMatchObject({
      acquired: true,
      lease: { owner_token: "owner-after-release", generation: 2 },
    });
  });

  it("clears history generation watermarks on logout release", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db);
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

describe("WhatsApp session lease fence on Postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("locks the lease row FOR UPDATE through the auth commit and rejects a stale generation", async () => {
    const repo = createWhatsAppSessionLeaseRepository(db);
    const acquired = await repo.acquire(owner("owner-a"));
    const fence = { ownerToken: "owner-a", generation: acquired.lease?.generation ?? 0 };
    let takeover: ReturnType<typeof repo.compareAndSwap> | undefined;
    await repo.withLeaseFence(fence, async (executor) => {
      await executor
        .updateTable("whatsapp_session_lease")
        .set({ heartbeat_at: "2000-01-01T00:00:00.000Z" })
        .where("id", "=", "default")
        .execute();
      takeover = repo.compareAndSwap("owner-a", owner("owner-b"));
      await executor.insertInto("whatsapp_creds").values({ id: "default", creds: "pg-fenced" }).execute();
    });
    await expect(takeover).resolves.toMatchObject({
      acquired: true,
      lease: { owner_token: "owner-b", generation: 2 },
    });
    await expect(
      db.selectFrom("whatsapp_creds").select("creds").where("id", "=", "default").executeTakeFirst(),
    ).resolves.toEqual({ creds: "pg-fenced" });

    await expect(repo.withLeaseFence(fence, async () => undefined)).rejects.toBeInstanceOf(WhatsAppLeaseFenceError);
  });
});
