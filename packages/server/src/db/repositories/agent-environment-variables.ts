import { randomUUID } from "node:crypto";
import type {
  AgentEnvironmentShareTargetInput,
  AgentEnvironmentShareTargetType,
  AgentEnvironmentVariableShareRecord,
} from "@sketch/shared";
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
  shares: AgentEnvironmentVariableShareRecord[];
}

export interface AgentEnvironmentRuntimeContext {
  currentUserId?: string | null;
  contextType?: "dm" | "channel_mention" | "scheduled_task";
  allowOrgSharedEnv?: boolean;
  taskContext?: {
    platform: "slack" | "whatsapp";
    contextType: "dm" | "channel" | "group";
    deliveryTarget: string;
    createdBy?: string | null;
  };
}

export class AgentEnvironmentVariableShareConflictError extends Error {
  constructor(
    public readonly variableName: string,
    public readonly targetLabel: string,
  ) {
    super(`Environment variable ${variableName} is already shared with ${targetLabel}.`);
    this.name = "AgentEnvironmentVariableShareConflictError";
  }
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
  encryptionKey: string | undefined,
  shares: AgentEnvironmentVariableShareRecord[],
): AgentEnvironmentVariableRecord {
  const isSecret = row.is_secret === 1;
  return {
    id: row.id,
    name: row.name,
    value: isSecret ? null : decryptAgentEnvValue(row.value, encryptionKey),
    isSecret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shares,
  };
}

function encodeValue(value: string, encryptionKey?: string): string {
  return encryptionKey ? encrypt(value, encryptionKey) : value;
}

const SHARE_TARGET_ORDER: Record<AgentEnvironmentShareTargetType, number> = {
  org: 0,
  user: 1,
  slack_channel: 2,
  whatsapp_group: 3,
};

function targetKey(target: AgentEnvironmentShareTargetInput): string {
  return `${target.type}:${target.id}`;
}

function normalizeTargets(targets: AgentEnvironmentShareTargetInput[]): AgentEnvironmentShareTargetInput[] {
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()];
}

function fallbackTargetLabel(targetType: AgentEnvironmentShareTargetType, targetId: string): string {
  if (targetType === "org") return "Entire org";
  if (targetType === "slack_channel") return "Slack channel";
  if (targetType === "whatsapp_group") return "WhatsApp group";
  if (targetType === "user") return "User";
  return targetId;
}

async function getTargetLabels(db: Kysely<DB>, targets: AgentEnvironmentShareTargetInput[]) {
  const labels = new Map<string, { label: string; secondaryLabel: string | null }>();
  const userIds = targets.filter((target) => target.type === "user").map((target) => target.id);
  const slackChannelIds = targets.filter((target) => target.type === "slack_channel").map((target) => target.id);
  const whatsappGroupJids = targets.filter((target) => target.type === "whatsapp_group").map((target) => target.id);

  for (const target of targets.filter((target) => target.type === "org")) {
    labels.set(targetKey(target), { label: "Entire org", secondaryLabel: null });
  }

  if (userIds.length > 0) {
    const users = await db.selectFrom("users").select(["id", "name", "email"]).where("id", "in", userIds).execute();
    for (const user of users) {
      labels.set(`user:${user.id}`, { label: user.name, secondaryLabel: user.email });
    }
  }

  if (slackChannelIds.length > 0) {
    const channels = await db
      .selectFrom("channels")
      .select(["slack_channel_id", "name"])
      .where("slack_channel_id", "in", slackChannelIds)
      .execute();
    for (const channel of channels) {
      labels.set(`slack_channel:${channel.slack_channel_id}`, {
        label: `#${channel.name}`,
        secondaryLabel: null,
      });
    }
  }

  if (whatsappGroupJids.length > 0) {
    const groups = await db
      .selectFrom("whatsapp_groups")
      .select(["jid", "name"])
      .where("jid", "in", whatsappGroupJids)
      .execute();
    for (const group of groups) {
      labels.set(`whatsapp_group:${group.jid}`, { label: group.name, secondaryLabel: null });
    }
  }

  return labels;
}

async function listSharesForVariables(
  db: Kysely<DB>,
  variableIds: string[],
): Promise<Map<string, AgentEnvironmentVariableShareRecord[]>> {
  const grouped = new Map<string, AgentEnvironmentVariableShareRecord[]>();
  if (variableIds.length === 0) return grouped;

  const rows = await db
    .selectFrom("agent_environment_variable_shares")
    .select(["id", "variable_id", "target_type", "target_id", "created_at"])
    .where("variable_id", "in", variableIds)
    .execute();
  const targets = rows.map((row) => ({
    type: row.target_type as AgentEnvironmentShareTargetType,
    id: row.target_id,
  }));
  const labels = await getTargetLabels(db, targets);

  for (const row of rows) {
    const targetType = row.target_type as AgentEnvironmentShareTargetType;
    const target = { type: targetType, id: row.target_id };
    const label = labels.get(targetKey(target)) ?? {
      label: fallbackTargetLabel(targetType, row.target_id),
      secondaryLabel: null,
    };
    const share: AgentEnvironmentVariableShareRecord = {
      id: row.id,
      targetType,
      targetId: row.target_id,
      targetLabel: label.label,
      targetSecondaryLabel: label.secondaryLabel,
      createdAt: row.created_at,
    };
    grouped.set(row.variable_id, [...(grouped.get(row.variable_id) ?? []), share]);
  }

  for (const shares of grouped.values()) {
    shares.sort((a, b) => {
      const order = SHARE_TARGET_ORDER[a.targetType] - SHARE_TARGET_ORDER[b.targetType];
      return order === 0 ? a.targetLabel.localeCompare(b.targetLabel) : order;
    });
  }

  return grouped;
}

export function createAgentEnvironmentVariableRepository(db: Kysely<DB>, encryptionKey?: string) {
  async function getOwnedVariable(id: string, userId: string): Promise<AgentEnvironmentVariableRecord | null> {
    const row = await db
      .selectFrom("agent_environment_variables")
      .selectAll()
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!row) return null;
    const shares = await listSharesForVariables(db, [id]);
    return serialize(row, encryptionKey, shares.get(id) ?? []);
  }

  async function applySharedEnv(env: Record<string, string>, target: AgentEnvironmentShareTargetInput) {
    const rows = await db
      .selectFrom("agent_environment_variable_shares as s")
      .innerJoin("agent_environment_variables as v", "v.id", "s.variable_id")
      .select(["v.name", "v.value"])
      .where("s.target_type", "=", target.type)
      .where("s.target_id", "=", target.id)
      .orderBy("v.name", "asc")
      .execute();
    for (const row of rows) {
      env[row.name] = decryptAgentEnvValue(row.value, encryptionKey);
    }
  }

  async function applyOwnedEnv(env: Record<string, string>, userId: string) {
    const rows = await db
      .selectFrom("agent_environment_variables")
      .select(["name", "value"])
      .where("user_id", "=", userId)
      .orderBy("name", "asc")
      .execute();
    for (const row of rows) {
      env[row.name] = decryptAgentEnvValue(row.value, encryptionKey);
    }
  }

  return {
    async list(userId: string): Promise<AgentEnvironmentVariableRecord[]> {
      const rows = await db
        .selectFrom("agent_environment_variables")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("name", "asc")
        .execute();
      const shares = await listSharesForVariables(
        db,
        rows.map((row) => row.id),
      );
      return rows.map((row) => serialize(row, encryptionKey, shares.get(row.id) ?? []));
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

    async existsForOwner(id: string, userId: string): Promise<boolean> {
      const row = await db
        .selectFrom("agent_environment_variables")
        .select("id")
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return Boolean(row);
    },

    async listForRuntimeContext(params: AgentEnvironmentRuntimeContext): Promise<Record<string, string>> {
      const env: Record<string, string> = {};
      const dmUserId = params.currentUserId ?? params.taskContext?.createdBy ?? null;
      const isDmContext = params.contextType === "dm" || params.taskContext?.contextType === "dm";
      const scheduledTaskCreatorId =
        params.contextType === "scheduled_task"
          ? (params.taskContext?.createdBy ?? params.currentUserId ?? null)
          : null;

      if (params.allowOrgSharedEnv !== false) {
        await applySharedEnv(env, { type: "org", id: "default" });
      }

      if (isDmContext && dmUserId) {
        await applySharedEnv(env, { type: "user", id: dmUserId });
        await applyOwnedEnv(env, dmUserId);
      } else if (params.taskContext?.platform === "slack" && params.taskContext.contextType === "channel") {
        await applySharedEnv(env, { type: "slack_channel", id: params.taskContext.deliveryTarget });
      } else if (params.taskContext?.platform === "whatsapp" && params.taskContext.contextType === "group") {
        await applySharedEnv(env, { type: "whatsapp_group", id: params.taskContext.deliveryTarget });
      }

      if (!isDmContext && scheduledTaskCreatorId) {
        await applyOwnedEnv(env, scheduledTaskCreatorId);
      }

      return env;
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
      return serialize(row, encryptionKey, []);
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
      if (!row) return null;
      const shares = await listSharesForVariables(db, [id]);
      return serialize(row, encryptionKey, shares.get(id) ?? []);
    },

    async replaceShares(
      id: string,
      ownerUserId: string,
      createdByUserId: string,
      targets: AgentEnvironmentShareTargetInput[],
    ): Promise<AgentEnvironmentVariableRecord | null> {
      const normalizedTargets = normalizeTargets(targets);
      await db.transaction().execute(async (trx) => {
        const variable = await trx
          .selectFrom("agent_environment_variables")
          .select(["id", "name"])
          .where("id", "=", id)
          .where("user_id", "=", ownerUserId)
          .executeTakeFirst();
        if (!variable) return;

        const labels = await getTargetLabels(trx, normalizedTargets);
        for (const target of normalizedTargets) {
          const conflict = await trx
            .selectFrom("agent_environment_variable_shares as s")
            .innerJoin("agent_environment_variables as v", "v.id", "s.variable_id")
            .select(["v.name"])
            .where("s.target_type", "=", target.type)
            .where("s.target_id", "=", target.id)
            .where("v.name", "=", variable.name)
            .where("v.id", "!=", variable.id)
            .executeTakeFirst();
          if (conflict) {
            const label = labels.get(targetKey(target))?.label ?? fallbackTargetLabel(target.type, target.id);
            throw new AgentEnvironmentVariableShareConflictError(variable.name, label);
          }
        }

        const desiredKeys = new Set(normalizedTargets.map(targetKey));
        const existing = await trx
          .selectFrom("agent_environment_variable_shares")
          .select(["id", "target_type", "target_id"])
          .where("variable_id", "=", id)
          .execute();

        for (const share of existing) {
          const key = `${share.target_type}:${share.target_id}`;
          if (!desiredKeys.has(key)) {
            await trx.deleteFrom("agent_environment_variable_shares").where("id", "=", share.id).execute();
          }
        }

        const existingKeys = new Set(existing.map((share) => `${share.target_type}:${share.target_id}`));
        for (const target of normalizedTargets) {
          if (existingKeys.has(targetKey(target))) continue;
          await trx
            .insertInto("agent_environment_variable_shares")
            .values({
              id: randomUUID(),
              variable_id: id,
              variable_name: variable.name,
              target_type: target.type,
              target_id: target.id,
              created_by: createdByUserId,
            })
            .execute();
        }
      });

      return getOwnedVariable(id, ownerUserId);
    },

    async deleteShare(id: string, ownerUserId: string, shareId: string): Promise<boolean> {
      const share = await db
        .selectFrom("agent_environment_variable_shares as s")
        .innerJoin("agent_environment_variables as v", "v.id", "s.variable_id")
        .select(["s.id"])
        .where("v.id", "=", id)
        .where("v.user_id", "=", ownerUserId)
        .where("s.id", "=", shareId)
        .executeTakeFirst();
      if (!share) return false;
      const result = await db
        .deleteFrom("agent_environment_variable_shares")
        .where("id", "=", share.id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
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
