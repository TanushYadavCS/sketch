import { Kysely, type Selectable, SqliteDialect, type Transaction, sql } from "kysely";
import { isPg } from "../dialect";
import type { DB, WhatsAppSessionLeaseTable } from "../schema";
import { type SqliteRetryOptions, withBoundedSqliteRetry } from "./whatsapp-inbound-events";

export const WHATSAPP_SESSION_LEASE_ID = "default";
export const WHATSAPP_SESSION_LEASE_STALE_SECONDS = 45;

export interface WhatsAppSessionLeaseOwner {
  ownerKind: "gateway" | "inprocess";
  ownerToken: string;
  gatewayHttpToken?: string | null;
  hostId: string;
  bootId: string;
  pid: number;
  pidStartTime: string;
  scriptHash: string;
  contractVersion: string;
}

export interface WhatsAppLeaseFence {
  ownerToken: string;
  generation: number;
}

export type WhatsAppLeaseFenceExecutor = Kysely<DB> | Transaction<DB>;

export interface WhatsAppSessionLeaseRepositoryOptions {
  sqlitePath?: string;
  sqliteRetry?: SqliteRetryOptions;
}

export class WhatsAppLeaseFenceError extends Error {
  constructor() {
    super("WhatsApp session lease fence rejected stale owner");
    this.name = "WhatsAppLeaseFenceError";
  }
}

function ownerValues(owner: WhatsAppSessionLeaseOwner) {
  return {
    owner_kind: owner.ownerKind,
    owner_token: owner.ownerToken,
    gateway_http_token: owner.gatewayHttpToken ?? null,
    host_id: owner.hostId,
    boot_id: owner.bootId,
    pid: owner.pid,
    pid_start_time: owner.pidStartTime,
    script_hash: owner.scriptHash,
    contract_version: owner.contractVersion,
  };
}

export function createWhatsAppSessionLeaseRepository(
  db: Kysely<DB>,
  options: WhatsAppSessionLeaseRepositoryOptions = {},
) {
  async function get() {
    return db
      .selectFrom("whatsapp_session_lease")
      .selectAll()
      .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
      .executeTakeFirst();
  }

  async function getFresh() {
    let query = db.selectFrom("whatsapp_session_lease").selectAll().where("id", "=", WHATSAPP_SESSION_LEASE_ID);
    query = isPg(db)
      ? query.where(sql<boolean>`heartbeat_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '45 seconds'`)
      : query.where(sql<boolean>`datetime(heartbeat_at) >= datetime(CURRENT_TIMESTAMP, '-45 seconds')`);
    return query.executeTakeFirst();
  }

  async function isOwned(fence: WhatsAppLeaseFence): Promise<boolean> {
    const row = await db
      .selectFrom("whatsapp_session_lease")
      .select("id")
      .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
      .where("owner_token", "=", fence.ownerToken)
      .where("generation", "=", fence.generation)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function acquire(
    owner: WhatsAppSessionLeaseOwner,
  ): Promise<{ acquired: boolean; lease: Selectable<WhatsAppSessionLeaseTable> | undefined }> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        let observed = await get();
        if (!observed) {
          try {
            await db
              .insertInto("whatsapp_session_lease")
              .values({
                id: WHATSAPP_SESSION_LEASE_ID,
                ...ownerValues(owner),
                generation: 1,
                heartbeat_at: sql`CURRENT_TIMESTAMP`,
                acquired_at: sql`CURRENT_TIMESTAMP`,
                last_live_at: null,
                disconnected_at: null,
              })
              .execute();
            return { acquired: true, lease: await get() };
          } catch (error) {
            observed = await get();
            if (!observed) throw error;
          }
        }

        if (observed.owner_token === owner.ownerToken) {
          await db
            .updateTable("whatsapp_session_lease")
            .set({ ...ownerValues(owner), heartbeat_at: sql`CURRENT_TIMESTAMP` })
            .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
            .where("owner_token", "=", owner.ownerToken)
            .execute();
          return { acquired: true, lease: await get() };
        }

        return compareAndSwapOnce(observed.owner_token, owner);
      },
      options.sqliteRetry,
    );
  }

  async function compareAndSwapOnce(
    observedOwnerToken: string,
    owner: WhatsAppSessionLeaseOwner,
  ): Promise<{ acquired: boolean; lease: Selectable<WhatsAppSessionLeaseTable> | undefined }> {
    let update = db
      .updateTable("whatsapp_session_lease")
      .set({
        ...ownerValues(owner),
        generation: sql`generation + 1`,
        heartbeat_at: sql`CURRENT_TIMESTAMP`,
        acquired_at: sql`CURRENT_TIMESTAMP`,
      })
      .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
      .where("owner_token", "=", observedOwnerToken);
    update = isPg(db)
      ? update.where(sql<boolean>`heartbeat_at::timestamptz < CURRENT_TIMESTAMP - INTERVAL '45 seconds'`)
      : update.where(sql<boolean>`datetime(heartbeat_at) < datetime(CURRENT_TIMESTAMP, '-45 seconds')`);
    const result = await update.executeTakeFirst();
    return { acquired: Number(result.numUpdatedRows) === 1, lease: await get() };
  }

  async function compareAndSwap(observedOwnerToken: string, owner: WhatsAppSessionLeaseOwner) {
    return withBoundedSqliteRetry(db, () => compareAndSwapOnce(observedOwnerToken, owner), options.sqliteRetry);
  }

  async function heartbeat(ownerToken: string, params: { markLive?: boolean } = {}): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_session_lease")
          .set({
            heartbeat_at: sql`CURRENT_TIMESTAMP`,
            ...(params.markLive ? { last_live_at: sql<string>`CURRENT_TIMESTAMP` } : {}),
          })
          .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
          .where("owner_token", "=", ownerToken)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      options.sqliteRetry,
    );
  }

  async function markDisconnected(fence: WhatsAppLeaseFence): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_session_lease")
          .set({ disconnected_at: sql`CURRENT_TIMESTAMP` })
          .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
          .where("owner_token", "=", fence.ownerToken)
          .where("generation", "=", fence.generation)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      options.sqliteRetry,
    );
  }

  async function deriveDisconnectedAt(fence: WhatsAppLeaseFence): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_session_lease")
          .set({ disconnected_at: sql`last_live_at` })
          .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
          .where("owner_token", "=", fence.ownerToken)
          .where("generation", "=", fence.generation)
          .where("last_live_at", "is not", null)
          .where((eb) => eb.or([eb("disconnected_at", "is", null), eb("disconnected_at", "<", eb.ref("last_live_at"))]))
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      options.sqliteRetry,
    );
  }

  async function releaseWithHistoryState(fence: WhatsAppLeaseFence, resetHistoryGeneration: boolean): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_session_lease")
          .set({
            owner_token: `released:${fence.ownerToken}`,
            heartbeat_at: "1970-01-01T00:00:00.000Z",
            ...(resetHistoryGeneration ? { last_live_at: null, disconnected_at: null } : {}),
          })
          .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
          .where("owner_token", "=", fence.ownerToken)
          .where("generation", "=", fence.generation)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      options.sqliteRetry,
    );
  }

  async function release(fence: WhatsAppLeaseFence): Promise<boolean> {
    return releaseWithHistoryState(fence, false);
  }

  /**
   * Credential-clearing logout starts a new account history generation, so the
   * release atomically removes reconnect watermarks while ordinary process
   * release preserves them for crash recovery.
   */
  async function releaseAfterLogout(fence: WhatsAppLeaseFence): Promise<boolean> {
    return releaseWithHistoryState(fence, true);
  }

  /**
   * Explicit logout can keep the current process and lease alive for a later QR
   * pairing, but must still reset history generation after credentials clear.
   */
  async function resetHistoryGeneration(fence: WhatsAppLeaseFence): Promise<boolean> {
    return withBoundedSqliteRetry(
      db,
      async () => {
        const result = await db
          .updateTable("whatsapp_session_lease")
          .set({ last_live_at: null, disconnected_at: null })
          .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
          .where("owner_token", "=", fence.ownerToken)
          .where("generation", "=", fence.generation)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      },
      options.sqliteRetry,
    );
  }

  async function assertFence(executor: WhatsAppLeaseFenceExecutor, fence: WhatsAppLeaseFence): Promise<void> {
    const lease = await executor
      .selectFrom("whatsapp_session_lease")
      .select(["owner_token", "generation"])
      .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
      .executeTakeFirst();
    if (lease?.owner_token !== fence.ownerToken || lease.generation !== fence.generation) {
      throw new WhatsAppLeaseFenceError();
    }
  }

  async function withLeaseFence<T>(
    fence: WhatsAppLeaseFence,
    callback: (executor: WhatsAppLeaseFenceExecutor) => Promise<T>,
  ): Promise<T> {
    if (isPg(db)) {
      return db.transaction().execute(async (trx) => {
        const lease = await trx
          .selectFrom("whatsapp_session_lease")
          .select(["owner_token", "generation"])
          .where("id", "=", WHATSAPP_SESSION_LEASE_ID)
          .forUpdate()
          .executeTakeFirst();
        if (lease?.owner_token !== fence.ownerToken || lease.generation !== fence.generation) {
          throw new WhatsAppLeaseFenceError();
        }
        return callback(trx);
      });
    }

    if (!options.sqlitePath || options.sqlitePath === ":memory:") {
      throw new Error("sqlitePath is required for the dedicated BEGIN IMMEDIATE lease fence");
    }
    return withBoundedSqliteRetry(
      db,
      async (remainingBudgetMs) => {
        const Database = (await import("better-sqlite3")).default;
        const raw = new Database(options.sqlitePath as string);
        raw.pragma("foreign_keys = ON");
        raw.pragma(`busy_timeout = ${Math.floor(Math.min(1000, remainingBudgetMs))}`);
        const fencedDb = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });

        try {
          raw.exec("BEGIN IMMEDIATE");
          await assertFence(fencedDb, fence);
          const result = await callback(fencedDb);
          raw.exec("COMMIT");
          return result;
        } catch (error) {
          if (raw.inTransaction) raw.exec("ROLLBACK");
          throw error;
        } finally {
          await fencedDb.destroy();
        }
      },
      options.sqliteRetry,
    );
  }

  return {
    get,
    getFresh,
    isOwned,
    acquire,
    compareAndSwap,
    heartbeat,
    markDisconnected,
    deriveDisconnectedAt,
    release,
    releaseAfterLogout,
    resetHistoryGeneration,
    withLeaseFence,
  };
}
