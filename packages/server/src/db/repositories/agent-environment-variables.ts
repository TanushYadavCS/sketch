import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { decrypt, encrypt } from "../../auth/encryption";
import type { DB } from "../schema";

export interface AgentEnvironmentVariableInput {
  name: string;
  value: string;
  isSecret: boolean;
}

export interface AgentEnvironmentVariableRecord {
  id: string;
  name: string;
  value: string | null;
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export function decryptAgentEnvValue(value: string, encryptionKey?: string): string {
  if (value.startsWith("enc:")) {
    if (!encryptionKey) {
      throw new Error("Encrypted agent environment variable found but ENCRYPTION_KEY is not set");
    }
    return decrypt(value, encryptionKey);
  }
  return value;
}

function serialize(
  row: {
    id: string;
    name: string;
    value: string;
    is_secret: number;
    created_at: string;
    updated_at: string;
  },
  encryptionKey?: string,
): AgentEnvironmentVariableRecord {
  const isSecret = row.is_secret === 1;
  return {
    id: row.id,
    name: row.name,
    value: isSecret ? null : decryptAgentEnvValue(row.value, encryptionKey),
    isSecret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeValue(value: string, encryptionKey?: string): string {
  return encryptionKey ? encrypt(value, encryptionKey) : value;
}

export function createAgentEnvironmentVariableRepository(db: Kysely<DB>, encryptionKey?: string) {
  return {
    async list(userId: string): Promise<AgentEnvironmentVariableRecord[]> {
      const rows = await db
        .selectFrom("agent_environment_variables")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("name", "asc")
        .execute();
      return rows.map((row) => serialize(row, encryptionKey));
    },

    async listForRuntime(userId: string): Promise<Record<string, string>> {
      const rows = await db
        .selectFrom("agent_environment_variables")
        .select(["name", "value"])
        .where("user_id", "=", userId)
        .orderBy("name", "asc")
        .execute();
      return Object.fromEntries(rows.map((row) => [row.name, decryptAgentEnvValue(row.value, encryptionKey)]));
    },

    async create(userId: string, data: AgentEnvironmentVariableInput): Promise<AgentEnvironmentVariableRecord> {
      const id = randomUUID();
      await db
        .insertInto("agent_environment_variables")
        .values({
          id,
          user_id: userId,
          name: data.name,
          value: encodeValue(data.value, encryptionKey),
          is_secret: data.isSecret ? 1 : 0,
        })
        .execute();
      const row = await db
        .selectFrom("agent_environment_variables")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      return serialize(row, encryptionKey);
    },

    async updateValue(id: string, userId: string, value: string): Promise<AgentEnvironmentVariableRecord | null> {
      await db
        .updateTable("agent_environment_variables")
        .set({ value: encodeValue(value, encryptionKey), updated_at: sql`CURRENT_TIMESTAMP` })
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .execute();
      const row = await db
        .selectFrom("agent_environment_variables")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row ? serialize(row, encryptionKey) : null;
    },

    async remove(id: string, userId: string): Promise<boolean> {
      const result = await db
        .deleteFrom("agent_environment_variables")
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
