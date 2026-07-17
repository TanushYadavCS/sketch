import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { createDbAuthState } from "./auth-store";

let db: Kysely<DB>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function withDelayedAuthLookup(
  sourceDb: Kysely<DB>,
  options: {
    table: "whatsapp_creds" | "whatsapp_keys";
    selectedColumn: string;
    started: { resolve: () => void };
    release: Promise<void>;
  },
): Kysely<DB> {
  type BuilderMethod = (...args: unknown[]) => unknown;

  const wrapBuilder = (builder: object, selectedTargetColumn: boolean): object =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) => {
            const columns = args.flat();
            const select = Reflect.get(target, "select") as BuilderMethod;
            const next = select.apply(target, args);
            if (!next || typeof next !== "object") return next;
            return wrapBuilder(next, selectedTargetColumn || columns.includes(options.selectedColumn));
          };
        }

        if (prop === "executeTakeFirst" && selectedTargetColumn) {
          return async (...args: unknown[]) => {
            options.started.resolve();
            await options.release;
            const executeTakeFirst = Reflect.get(target, "executeTakeFirst") as BuilderMethod;
            return executeTakeFirst.apply(target, args);
          };
        }

        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;

        return (...args: unknown[]) => {
          const next = value.apply(target, args);
          if (next && typeof next === "object") {
            return wrapBuilder(next, selectedTargetColumn);
          }
          return next;
        };
      },
    });

  return new Proxy(sourceDb, {
    get(target, prop, receiver) {
      if (prop !== "selectFrom") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (table: string) => {
        const builder = (target as { selectFrom: (tableName: string) => object }).selectFrom(table);
        if (table !== options.table) return builder;
        return wrapBuilder(builder, false);
      };
    },
  }) as Kysely<DB>;
}

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

describe("createDbAuthState", () => {
  it("initializes fresh creds when no creds stored", async () => {
    const { state } = await createDbAuthState(db);
    expect(state.creds).toBeDefined();
    expect(state.creds.registrationId).toBeDefined();
  });

  it("saveCreds persists and subsequent load retrieves correctly", async () => {
    const { state, saveCreds } = await createDbAuthState(db);
    const originalRegId = state.creds.registrationId;
    await saveCreds();

    const { state: state2 } = await createDbAuthState(db);
    expect(state2.creds.registrationId).toBe(originalRegId);
  });

  it("routes credential and key write batches through the configured lease fence", async () => {
    let fencedBatches = 0;
    const { state, saveCreds, clearCreds } = await createDbAuthState(db, undefined, {
      withWriteFence: async (callback) => {
        fencedBatches += 1;
        return db.transaction().execute(callback);
      },
    });
    await saveCreds();
    await state.keys.set({ session: { "1": { data: "fenced" } as never } });
    await clearCreds();
    expect(fencedBatches).toBe(3);
  });

  it("saveCreds overwrites existing creds (upsert)", async () => {
    const { state, saveCreds } = await createDbAuthState(db);
    await saveCreds();

    Object.assign(state.creds, { registrationId: 99999 });
    await saveCreds();

    const { state: state2 } = await createDbAuthState(db);
    expect(state2.creds.registrationId).toBe(99999);
  });

  it("keys.set stores keys and keys.get retrieves them", async () => {
    const { state } = await createDbAuthState(db);
    await state.keys.set({ "pre-key": { "1": { keyPair: "test-data" } as never } });
    const result = await state.keys.get("pre-key", ["1"]);
    expect(result["1"]).toEqual({ keyPair: "test-data" } as never);
  });

  it("keys.get returns empty object for unknown ids", async () => {
    const { state } = await createDbAuthState(db);
    const result = await state.keys.get("pre-key", ["999"]);
    expect(result).toEqual({});
  });

  it("keys.set with null value deletes the key from DB", async () => {
    const { state } = await createDbAuthState(db);
    await state.keys.set({ "pre-key": { "1": { keyPair: "test" } as never } });
    await state.keys.set({ "pre-key": { "1": null } });

    // Create a fresh auth state to bypass the in-memory cache layer
    // and verify the key was actually deleted from the database
    const { state: fresh } = await createDbAuthState(db);
    const result = await fresh.keys.get("pre-key", ["1"]);
    expect(result["1"]).toBeUndefined();
  });

  it("keys.set with multiple types stores each independently", async () => {
    const { state } = await createDbAuthState(db);
    await state.keys.set({
      "pre-key": { "1": { data: "pk" } as never },
      session: { "2": { data: "sess" } as never },
    });
    const pk = await state.keys.get("pre-key", ["1"]);
    const sess = await state.keys.get("session", ["2"]);
    expect(pk["1"]).toEqual({ data: "pk" });
    expect(sess["2"]).toEqual({ data: "sess" });
  });

  it("clearCreds removes all creds and keys", async () => {
    const { state, saveCreds, clearCreds } = await createDbAuthState(db);
    await saveCreds();
    await state.keys.set({ "pre-key": { "1": { data: "test" } as never } });
    await clearCreds();

    const credsRows = await db.selectFrom("whatsapp_creds").selectAll().execute();
    const keyRows = await db.selectFrom("whatsapp_keys").selectAll().execute();
    expect(credsRows).toEqual([]);
    expect(keyRows).toEqual([]);

    const { state: state2 } = await createDbAuthState(db);
    expect(state2.creds).toBeDefined();
    const result = await state2.keys.get("pre-key", ["1"]);
    expect(result["1"]).toBeUndefined();
  });

  it("ignores late writes after clearCreds", async () => {
    const { state, saveCreds, clearCreds } = await createDbAuthState(db);
    await clearCreds();

    await saveCreds();
    await state.keys.set({ session: { "1": { data: "late-write" } as never } });

    const credsRows = await db.selectFrom("whatsapp_creds").selectAll().execute();
    const keyRows = await db.selectFrom("whatsapp_keys").selectAll().execute();
    expect(credsRows).toEqual([]);
    expect(keyRows).toEqual([]);
  });

  it("ignores in-flight saveCreds writes that resume after clearCreds", async () => {
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    const delayedDb = withDelayedAuthLookup(db, {
      table: "whatsapp_creds",
      selectedColumn: "id",
      started: lookupStarted,
      release: releaseLookup.promise,
    });
    const { saveCreds, clearCreds } = await createDbAuthState(delayedDb);

    const pendingSave = saveCreds();
    await lookupStarted.promise;
    await clearCreds();
    releaseLookup.resolve();
    await pendingSave;

    const credsRows = await db.selectFrom("whatsapp_creds").selectAll().execute();
    expect(credsRows).toEqual([]);
  });

  it("ignores in-flight key writes that resume after clearCreds", async () => {
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    const delayedDb = withDelayedAuthLookup(db, {
      table: "whatsapp_keys",
      selectedColumn: "key_id",
      started: lookupStarted,
      release: releaseLookup.promise,
    });
    const { state, clearCreds } = await createDbAuthState(delayedDb);

    const pendingSet = state.keys.set({ session: { "1": { data: "late-write" } as never } });
    await lookupStarted.promise;
    await clearCreds();
    releaseLookup.resolve();
    await pendingSet;

    const keyRows = await db.selectFrom("whatsapp_keys").selectAll().execute();
    expect(keyRows).toEqual([]);
  });
});
