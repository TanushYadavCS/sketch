import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  type SignalDataTypeMap,
  initAuthCreds,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";

/**
 * DB-backed Baileys credential and Signal key storage.
 * Replaces useMultiFileAuthState with Kysely/SQLite storage.
 * Auth keys update on every sent/received message -- DB is cleaner
 * than high-frequency file writes. Also consolidates all persistent
 * state in one place (backup = copy sketch.db).
 */
export async function createDbAuthState(
  db: Kysely<DB>,
  logger?: Logger,
  options: {
    withWriteFence?: <T>(callback: (executor: Kysely<DB> | Transaction<DB>) => Promise<T>) => Promise<T>;
  } = {},
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearCreds: () => Promise<void>;
}> {
  let cleared = false;
  const row = await db.selectFrom("whatsapp_creds").selectAll().where("id", "=", "default").executeTakeFirst();
  const creds: AuthenticationCreds = row ? JSON.parse(row.creds, BufferJSON.reviver) : initAuthCreds();
  const write = options.withWriteFence ?? (async (callback) => callback(db));

  const saveCreds = async () => {
    if (cleared) return;
    const json = JSON.stringify(creds, BufferJSON.replacer);
    await write(async (executor) => {
      const existing = await executor
        .selectFrom("whatsapp_creds")
        .select("id")
        .where("id", "=", "default")
        .executeTakeFirst();
      if (cleared) return;
      if (existing) {
        await executor.updateTable("whatsapp_creds").set({ creds: json }).where("id", "=", "default").execute();
      } else {
        await executor.insertInto("whatsapp_creds").values({ id: "default", creds: json }).execute();
      }
    });
  };

  const clearCreds = async () => {
    cleared = true;
    await write(async (executor) => {
      await executor.deleteFrom("whatsapp_creds").execute();
      await executor.deleteFrom("whatsapp_keys").execute();
    });
  };

  const keys: AuthenticationState["keys"] = makeCacheableSignalKeyStore(
    {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const rows = await db
          .selectFrom("whatsapp_keys")
          .selectAll()
          .where("type", "=", type)
          .where("key_id", "in", ids)
          .execute();

        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const row of rows) {
          result[row.key_id] = JSON.parse(row.value, BufferJSON.reviver);
        }
        return result;
      },
      async set(data: Record<string, Record<string, unknown>>) {
        if (cleared) return;
        await write(async (executor) => {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              if (cleared) return;
              if (value === null || value === undefined) {
                await executor.deleteFrom("whatsapp_keys").where("type", "=", type).where("key_id", "=", id).execute();
              } else {
                const json = JSON.stringify(value, BufferJSON.replacer);
                const existing = await executor
                  .selectFrom("whatsapp_keys")
                  .select("key_id")
                  .where("type", "=", type)
                  .where("key_id", "=", id)
                  .executeTakeFirst();
                if (cleared) return;
                if (existing) {
                  await executor
                    .updateTable("whatsapp_keys")
                    .set({ value: json })
                    .where("type", "=", type)
                    .where("key_id", "=", id)
                    .execute();
                } else {
                  await executor.insertInto("whatsapp_keys").values({ type, key_id: id, value: json }).execute();
                }
              }
            }
          }
        });
      },
    },
    logger as unknown as Parameters<typeof makeCacheableSignalKeyStore>[1],
  );

  return {
    state: { creds, keys },
    saveCreds,
    clearCreds,
  };
}
