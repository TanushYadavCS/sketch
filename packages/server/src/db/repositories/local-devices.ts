import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { DB, LocalDeviceToolCallsTable, LocalDevicesTable } from "../schema";

export type LocalDeviceRow = Selectable<LocalDevicesTable>;
export type LocalDeviceToolCallRow = Selectable<LocalDeviceToolCallsTable>;

export function createLocalDeviceRepository(db: Kysely<DB>) {
  return {
    async create(input: {
      userId: string;
      name: string;
      platform: string;
      tokenHash: string;
      prefix: string;
    }): Promise<LocalDeviceRow> {
      const id = randomUUID();
      await db
        .insertInto("local_devices")
        .values({
          id,
          user_id: input.userId,
          name: input.name,
          platform: input.platform,
          token_hash: input.tokenHash,
          prefix: input.prefix,
        })
        .execute();
      return db.selectFrom("local_devices").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async listForUser(userId: string): Promise<LocalDeviceRow[]> {
      return db
        .selectFrom("local_devices")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .execute();
    },

    async findActiveByHash(tokenHash: string): Promise<LocalDeviceRow | undefined> {
      return db
        .selectFrom("local_devices")
        .selectAll()
        .where("token_hash", "=", tokenHash)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
    },

    async findActiveById(userId: string, deviceId: string): Promise<LocalDeviceRow | undefined> {
      return db
        .selectFrom("local_devices")
        .selectAll()
        .where("id", "=", deviceId)
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
    },

    async revoke(userId: string, deviceId: string): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await db
        .updateTable("local_devices")
        .set({ revoked_at: now, status: "offline", updated_at: now })
        .where("id", "=", deviceId)
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async markConnected(deviceId: string, now = new Date()): Promise<void> {
      await db
        .updateTable("local_devices")
        .set({ status: "online", last_seen_at: now.toISOString(), updated_at: now.toISOString() })
        .where("id", "=", deviceId)
        .where("revoked_at", "is", null)
        .execute();
    },

    async touch(deviceId: string, now = new Date()): Promise<void> {
      await db
        .updateTable("local_devices")
        .set({ last_seen_at: now.toISOString(), updated_at: now.toISOString() })
        .where("id", "=", deviceId)
        .where("revoked_at", "is", null)
        .execute();
    },

    async markDisconnected(deviceId: string, now = new Date()): Promise<void> {
      await db
        .updateTable("local_devices")
        .set({ status: "offline", updated_at: now.toISOString() })
        .where("id", "=", deviceId)
        .where("revoked_at", "is", null)
        .execute();
    },

    async recordToolCall(input: {
      deviceId: string;
      userId: string;
      toolName: string;
      command: string;
      cwd?: string | null;
      success: boolean;
      exitCode?: number | null;
      timedOut?: boolean;
      durationMs: number;
      stdoutBytes?: number;
      stderrBytes?: number;
      stdoutTruncated?: boolean;
      stderrTruncated?: boolean;
      errorMessage?: string | null;
    }): Promise<LocalDeviceToolCallRow> {
      const id = randomUUID();
      await db
        .insertInto("local_device_tool_calls")
        .values({
          id,
          device_id: input.deviceId,
          user_id: input.userId,
          tool_name: input.toolName,
          command: input.command,
          cwd: input.cwd ?? null,
          success: input.success ? 1 : 0,
          exit_code: input.exitCode ?? null,
          timed_out: input.timedOut ? 1 : 0,
          duration_ms: input.durationMs,
          stdout_bytes: input.stdoutBytes ?? 0,
          stderr_bytes: input.stderrBytes ?? 0,
          stdout_truncated: input.stdoutTruncated ? 1 : 0,
          stderr_truncated: input.stderrTruncated ? 1 : 0,
          error_message: input.errorMessage ?? null,
        })
        .execute();
      return db.selectFrom("local_device_tool_calls").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },
  };
}
