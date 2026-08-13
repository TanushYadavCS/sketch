import { randomUUID } from "node:crypto";
import {
  type AgentEnvironmentShareTargetInput,
  type CliIntegrationAppId,
  type CliIntegrationCatalogApp,
  type CliIntegrationConnection,
  cliIntegrationAppDefinition,
  cliIntegrationAppDefinitions,
  cliSkillRequiredEnv,
} from "@sketch/shared";
import { type Kysely, sql } from "kysely";
import { decrypt, encrypt } from "../../auth/encryption";
import type {
  AgentEnvironmentRuntimeContext,
  createAgentEnvironmentVariableRepository,
} from "../../db/repositories/agent-environment-variables";
import {
  type CliIntegrationConnectionRow,
  createCliIntegrationConnectionsRepository,
} from "../../db/repositories/cli-integration-connections";
import type { DB } from "../../db/schema";
import { type GithubIdentity, assertGithubCliAvailable, validateGithubTokenInput, verifyGithubToken } from "./github";
import { listCliIntegrationDefinitions } from "./registry";

const GITHUB_APP_ID: CliIntegrationAppId = "github";
const GITHUB_ENV_NAME = "GH_TOKEN";

export type CliIntegrationRuntimeAvailability = {
  appId: CliIntegrationAppId;
  skillId: string;
  available: boolean;
  status: "active" | "invalid" | "missing";
  reason: string | null;
};

export class CliIntegrationServiceError extends Error {
  constructor(
    public readonly code:
      | "ALREADY_CONNECTED"
      | "MANAGED_ENVIRONMENT_VARIABLE"
      | "NOT_FOUND"
      | "INVALID_TOKEN"
      | "RATE_LIMITED"
      | "UPSTREAM_UNAVAILABLE"
      | "CLI_INTEGRATION_UNAVAILABLE"
      | "ENCRYPTION_UNAVAILABLE"
      | "CONFLICT",
    message: string,
    public readonly status: 400 | 401 | 404 | 409 | 429 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = "CliIntegrationServiceError";
  }
}

function mapVerificationError(error: unknown): CliIntegrationServiceError {
  if (error instanceof CliIntegrationServiceError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const upstreamStatus = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (code === "INVALID_TOKEN")
    return new CliIntegrationServiceError(
      "INVALID_TOKEN",
      upstreamStatus === 400 ? "Enter a GitHub personal access token." : "GitHub rejected this token.",
      upstreamStatus === 400 ? 400 : 401,
    );
  if (code === "RATE_LIMITED")
    return new CliIntegrationServiceError("RATE_LIMITED", "GitHub rate limit reached. Try again later.", 429);
  if (code === "CLI_INTEGRATION_UNAVAILABLE") {
    return new CliIntegrationServiceError(
      "CLI_INTEGRATION_UNAVAILABLE",
      "GitHub CLI is unavailable on this Sketch deployment.",
      503,
    );
  }
  return new CliIntegrationServiceError("UPSTREAM_UNAVAILABLE", "GitHub is unavailable. Try again later.", 502);
}

function encodeValue(value: string, encryptionKey?: string): string {
  return encryptionKey ? encrypt(value, encryptionKey) : value;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return isUniqueConstraintError(candidate.cause);
}

function targetKey(target: AgentEnvironmentShareTargetInput): string {
  return `${target.type}:${target.id}`;
}

function normalizeTargets(targets: AgentEnvironmentShareTargetInput[]): AgentEnvironmentShareTargetInput[] {
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()];
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof CliIntegrationServiceError) return error.message;
  return "GitHub verification failed.";
}

export function createCliIntegrationService(params: {
  db: Kysely<DB>;
  encryptionKey?: string;
  environmentVariables: ReturnType<typeof createAgentEnvironmentVariableRepository>;
}) {
  const connections = createCliIntegrationConnectionsRepository(params.db);

  async function getShares(variableId: string): Promise<AgentEnvironmentShareTargetInput[]> {
    const rows = await params.db
      .selectFrom("agent_environment_variable_shares")
      .select(["target_type", "target_id"])
      .where("variable_id", "=", variableId)
      .orderBy("target_type", "asc")
      .orderBy("target_id", "asc")
      .execute();
    return rows.map((row) => ({
      type: row.target_type as AgentEnvironmentShareTargetInput["type"],
      id: row.target_id,
    }));
  }

  async function serialize(row: CliIntegrationConnectionRow, viewerUserId: string): Promise<CliIntegrationConnection> {
    const definition = cliIntegrationAppDefinition(row.app_id);
    if (!definition) throw new Error(`Unknown CLI integration app: ${row.app_id}`);
    const owner = await params.db
      .selectFrom("users")
      .select(["id", "name"])
      .where("id", "=", row.owner_user_id)
      .executeTakeFirst();
    const shares = await getShares(row.credential_variable_id);
    const isOwned = row.owner_user_id === viewerUserId;
    return {
      id: row.id,
      appId: definition.id,
      appName: definition.name,
      executionMode: "cli",
      ownerUserId: row.owner_user_id,
      ownerName: owner?.name ?? null,
      accountExternalId: row.account_external_id,
      accountLogin: row.account_login,
      accountAvatarUrl: row.account_avatar_url,
      accountType: row.account_type,
      status: row.status as CliIntegrationConnection["status"],
      verifiedAt: row.verified_at,
      lastVerificationError: row.last_verification_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isOwnedByViewer: isOwned,
      canUse: row.status === "active",
      canManage: isOwned,
      shares: isOwned ? shares : [],
    };
  }

  function assertEncryptionAvailable(): void {
    if (!params.encryptionKey) {
      throw new CliIntegrationServiceError(
        "ENCRYPTION_UNAVAILABLE",
        "GitHub integration requires ENCRYPTION_KEY to encrypt credentials at rest.",
        503,
      );
    }
  }

  async function verify(token: string): Promise<GithubIdentity> {
    try {
      validateGithubTokenInput(token);
      await assertGithubCliAvailable();
      return await verifyGithubToken(token);
    } catch (error) {
      throw mapVerificationError(error);
    }
  }

  async function assertOwnerVariableAvailable(ownerUserId: string, executor: Kysely<DB> = params.db): Promise<void> {
    const existing = await executor
      .selectFrom("agent_environment_variables")
      .select(["id"])
      .where("user_id", "=", ownerUserId)
      .where("name", "=", GITHUB_ENV_NAME)
      .executeTakeFirst();
    if (existing) {
      throw new CliIntegrationServiceError(
        "MANAGED_ENVIRONMENT_VARIABLE",
        "GH_TOKEN already exists as an environment variable. Rename or remove it before connecting GitHub.",
        409,
      );
    }
  }

  async function insertShares(
    executor: Kysely<DB>,
    variableId: string,
    createdBy: string,
    targets: AgentEnvironmentShareTargetInput[],
  ): Promise<void> {
    for (const target of normalizeTargets(targets)) {
      await executor
        .insertInto("agent_environment_variable_shares")
        .values({
          id: randomUUID(),
          variable_id: variableId,
          variable_name: GITHUB_ENV_NAME,
          target_type: target.type,
          target_id: target.id,
          created_by: createdBy,
        })
        .execute();
    }
  }

  async function isExternalRuntimeUser(context: AgentEnvironmentRuntimeContext): Promise<boolean> {
    const userId = context.taskContext?.createdBy ?? context.currentUserId ?? null;
    if (!userId || userId === "unknown") return true;
    const user = await params.db.selectFrom("users").select("type").where("id", "=", userId).executeTakeFirst();
    return user?.type === "external";
  }

  async function runtimeConnectionRows(
    context: AgentEnvironmentRuntimeContext,
  ): Promise<CliIntegrationConnectionRow[]> {
    if (await isExternalRuntimeUser(context)) return [];
    const task = context.taskContext;
    const isDmContext = context.contextType === "dm" || task?.contextType === "dm";
    const isScheduledTask = context.contextType === "scheduled_task";
    const ownerUserId = isDmContext || isScheduledTask ? (task?.createdBy ?? context.currentUserId ?? null) : null;
    const targets: AgentEnvironmentShareTargetInput[] = [];
    if (task?.contextType === "channel" && task.platform === "slack") {
      targets.push({ type: "slack_channel", id: task.deliveryTarget });
    } else if (task?.contextType === "group" && task.platform === "whatsapp") {
      targets.push({ type: "whatsapp_group", id: task.deliveryTarget });
    } else if (isDmContext && ownerUserId) {
      targets.push({ type: "user", id: ownerUserId });
    }
    if (context.allowOrgSharedEnv !== false) {
      targets.push({ type: "org", id: "default" });
    }

    const shareConditions = targets.map(
      (target) =>
        sql<boolean>`EXISTS (
        SELECT 1
        FROM agent_environment_variable_shares AS s
        WHERE s.variable_id = c.credential_variable_id
          AND s.target_type = ${target.type}
          AND s.target_id = ${target.id}
      )`,
    );
    return params.db
      .selectFrom("cli_integration_connections as c")
      .selectAll("c")
      .where("c.app_id", "=", GITHUB_APP_ID)
      .where((eb) => eb.or([...(ownerUserId ? [eb("c.owner_user_id", "=", ownerUserId)] : []), ...shareConditions]))
      .execute();
  }

  async function updateVariableValue(
    variableId: string,
    ownerUserId: string,
    token: string,
    executor: Kysely<DB>,
  ): Promise<void> {
    const result = await executor
      .updateTable("agent_environment_variables")
      .set({ value: encodeValue(token, params.encryptionKey), updated_at: new Date().toISOString() })
      .where("id", "=", variableId)
      .where("user_id", "=", ownerUserId)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0)
      throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
  }

  return {
    listCatalog(query?: string): CliIntegrationCatalogApp[] {
      return listCliIntegrationDefinitions(query).map((definition) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        icon: definition.icon,
        executionMode: "cli",
        connected: false,
        connectionId: null,
      }));
    },

    async validateAgentSkills(
      ownerUserId: string,
      skillIds: string[],
      taskContext?: AgentEnvironmentRuntimeContext["taskContext"],
    ): Promise<string[]> {
      const requested = [...new Set(skillIds.map((skill) => skill.trim().toLowerCase()).filter(Boolean))];
      if (!requested.some((skill) => cliSkillRequiredEnv(skill).length > 0)) return [];
      const context: AgentEnvironmentRuntimeContext = {
        currentUserId: ownerUserId,
        contextType: "scheduled_task",
        allowOrgSharedEnv: true,
        ...(taskContext ? { taskContext } : {}),
      };
      const env = await params.environmentVariables.listForRuntimeContext(context);
      const rows = await runtimeConnectionRows(context);
      const available = rows.some(
        (row) => row.app_id === GITHUB_APP_ID && row.status === "active" && Boolean(env[GITHUB_ENV_NAME]),
      );
      return available ? [] : ["github"];
    },

    async findManagedVariable(id: string, ownerUserId: string): Promise<boolean> {
      const row = await params.db
        .selectFrom("cli_integration_connections")
        .select("id")
        .where("credential_variable_id", "=", id)
        .where("owner_user_id", "=", ownerUserId)
        .executeTakeFirst();
      return Boolean(row);
    },

    async isManagedVariableName(name: string, ownerUserId: string): Promise<boolean> {
      const row = await params.db
        .selectFrom("cli_integration_connections as c")
        .innerJoin("agent_environment_variables as v", "v.id", "c.credential_variable_id")
        .select("c.id")
        .where("c.owner_user_id", "=", ownerUserId)
        .where("v.name", "=", name)
        .executeTakeFirst();
      return Boolean(row);
    },

    async canManage(ownerUserId: string, connectionId: string): Promise<boolean> {
      const row = await connections.findByIdAndOwner(connectionId, ownerUserId);
      return row?.app_id === GITHUB_APP_ID;
    },

    async getManagedVariableApp(variableId: string, ownerUserId: string): Promise<string | null> {
      const row = await params.db
        .selectFrom("cli_integration_connections")
        .select("app_id")
        .where("credential_variable_id", "=", variableId)
        .where("owner_user_id", "=", ownerUserId)
        .executeTakeFirst();
      const name = cliIntegrationAppDefinition(row?.app_id ?? "")?.name ?? row?.app_id ?? null;
      return name ? `${name} integration` : null;
    },

    async listConnections(
      viewerUserId: string,
      context?: { platform?: "slack" | "whatsapp"; deliveryTarget?: string },
    ): Promise<CliIntegrationConnection[]> {
      const targetContext = context
        ? {
            ...(context.platform === "slack" && context.deliveryTarget
              ? { slackChannelId: context.deliveryTarget }
              : {}),
            ...(context.platform === "whatsapp" && context.deliveryTarget
              ? { whatsappGroupJid: context.deliveryTarget }
              : {}),
          }
        : undefined;
      const viewer = await params.db
        .selectFrom("users")
        .select("type")
        .where("id", "=", viewerUserId)
        .executeTakeFirst();
      if (viewer?.type === "external") return [];
      const rows = await connections.listForViewer(viewerUserId, targetContext);
      const result = await Promise.all(rows.map((row) => serialize(row, viewerUserId)));
      return result.sort((left, right) => Number(right.isOwnedByViewer) - Number(left.isOwnedByViewer));
    },

    async verifyGitHubToken(token: string): Promise<GithubIdentity> {
      return verify(token);
    },

    async connectGitHub(
      ownerUserId: string,
      token: string,
      targets: AgentEnvironmentShareTargetInput[] = [],
    ): Promise<CliIntegrationConnection> {
      assertEncryptionAvailable();
      const identity = await verify(token);
      const existing = await connections.findByOwnerAndApp(ownerUserId, GITHUB_APP_ID);
      if (existing) throw new CliIntegrationServiceError("ALREADY_CONNECTED", "GitHub is already connected.", 409);

      const now = new Date().toISOString();
      const variableId = randomUUID();
      const connectionId = randomUUID();
      try {
        const row = await params.db.transaction().execute(async (trx) => {
          await assertOwnerVariableAvailable(ownerUserId, trx);
          await trx
            .insertInto("agent_environment_variables")
            .values({
              id: variableId,
              user_id: ownerUserId,
              name: GITHUB_ENV_NAME,
              value: encodeValue(token.trim(), params.encryptionKey),
              is_secret: 1,
              created_at: now,
              updated_at: now,
            })
            .execute();
          const created = await connections.create(
            {
              id: connectionId,
              appId: GITHUB_APP_ID,
              ownerUserId,
              credentialVariableId: variableId,
              accountExternalId: identity.externalId,
              accountLogin: identity.login,
              accountAvatarUrl: identity.avatarUrl,
              accountType: identity.accountType,
              status: "active",
              verifiedAt: now,
              lastVerificationError: null,
            },
            trx,
          );
          await insertShares(trx, variableId, ownerUserId, targets);
          return created;
        });
        if (!row) throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection was not created.", 404);
        return serialize(row, ownerUserId);
      } catch (error) {
        if (error instanceof CliIntegrationServiceError) throw error;
        if (isUniqueConstraintError(error)) {
          throw new CliIntegrationServiceError("ALREADY_CONNECTED", "GitHub is already connected.", 409);
        }
        throw error;
      }
    },

    async updateGitHubToken(
      ownerUserId: string,
      connectionId: string,
      token: string,
    ): Promise<CliIntegrationConnection> {
      assertEncryptionAvailable();
      const existing = await connections.findByIdAndOwner(connectionId, ownerUserId);
      if (!existing || existing.app_id !== GITHUB_APP_ID) {
        throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
      }
      const identity = await verify(token);
      const now = new Date().toISOString();
      const row = await params.db.transaction().execute(async (trx) => {
        await updateVariableValue(existing.credential_variable_id, ownerUserId, token.trim(), trx);
        return connections.updateVerification(
          connectionId,
          ownerUserId,
          {
            accountExternalId: identity.externalId,
            accountLogin: identity.login,
            accountAvatarUrl: identity.avatarUrl,
            accountType: identity.accountType,
            status: "active",
            verifiedAt: now,
            lastVerificationError: null,
          },
          trx,
        );
      });
      if (!row) throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
      return serialize(row, ownerUserId);
    },

    async reverify(ownerUserId: string, connectionId: string): Promise<CliIntegrationConnection> {
      const existing = await connections.findByIdAndOwner(connectionId, ownerUserId);
      if (!existing || existing.app_id !== GITHUB_APP_ID) {
        throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
      }
      const variables = await params.db
        .selectFrom("agent_environment_variables")
        .select(["value"])
        .where("id", "=", existing.credential_variable_id)
        .where("user_id", "=", ownerUserId)
        .executeTakeFirst();
      if (!variables) throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);

      try {
        const token = variables.value.startsWith("enc:")
          ? decrypt(variables.value, params.encryptionKey ?? "")
          : variables.value;
        const identity = await verify(token);
        const row = await connections.updateVerification(connectionId, ownerUserId, {
          accountExternalId: identity.externalId,
          accountLogin: identity.login,
          accountAvatarUrl: identity.avatarUrl,
          accountType: identity.accountType,
          status: "active",
          verifiedAt: new Date().toISOString(),
          lastVerificationError: null,
        });
        if (!row) throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
        return serialize(row, ownerUserId);
      } catch (error) {
        const mapped = mapVerificationError(error);
        if (mapped.code !== "INVALID_TOKEN") throw mapped;
        const row = await connections.markInvalid(connectionId, ownerUserId, safeErrorMessage(mapped));
        if (!row) throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
        return serialize(row, ownerUserId);
      }
    },

    async replaceShares(
      ownerUserId: string,
      connectionId: string,
      targets: AgentEnvironmentShareTargetInput[],
    ): Promise<CliIntegrationConnection> {
      const existing = await connections.findByIdAndOwner(connectionId, ownerUserId);
      if (!existing || existing.app_id !== GITHUB_APP_ID) {
        throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
      }
      const variable = await params.environmentVariables.replaceShares(
        existing.credential_variable_id,
        ownerUserId,
        ownerUserId,
        normalizeTargets(targets),
      );
      if (!variable) throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
      const row = await connections.findByIdAndOwner(connectionId, ownerUserId);
      if (!row) throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
      return serialize(row, ownerUserId);
    },

    async disconnect(ownerUserId: string, connectionId: string): Promise<void> {
      const existing = await connections.findByIdAndOwner(connectionId, ownerUserId);
      if (!existing || existing.app_id !== GITHUB_APP_ID) {
        throw new CliIntegrationServiceError("NOT_FOUND", "GitHub connection not found.", 404);
      }
      await params.db.transaction().execute(async (trx) => {
        await connections.delete(connectionId, ownerUserId, trx);
        await trx
          .deleteFrom("agent_environment_variables")
          .where("id", "=", existing.credential_variable_id)
          .where("user_id", "=", ownerUserId)
          .execute();
      });
    },

    async resolveAvailability(context: AgentEnvironmentRuntimeContext): Promise<CliIntegrationRuntimeAvailability[]> {
      const env = await params.environmentVariables.listForRuntimeContext(context);
      const relevantRows = await runtimeConnectionRows(context);
      return Object.values(cliIntegrationAppDefinitions).map((definition) => {
        const requiredEnv = definition.credentialFields.map((field) => field.envName);
        const matching = relevantRows.filter((row) => row.app_id === definition.id);
        const active = matching.some(
          (row) => row.status === "active" && requiredEnv.every((name) => typeof env[name] === "string" && env[name]),
        );
        const invalid = matching.some((row) => row.status === "invalid");
        return {
          appId: definition.id,
          skillId: definition.skillId,
          available: active,
          status: active ? "active" : invalid ? "invalid" : "missing",
          reason: active ? null : invalid ? "Reconnect GitHub to restore access." : "Connect GitHub to use this skill.",
        };
      });
    },

    async filterRuntimeEnvironment(
      context: AgentEnvironmentRuntimeContext,
      environment: Record<string, string>,
    ): Promise<Record<string, string>> {
      const filtered = { ...environment };
      const availability = await this.resolveAvailability(context);
      const matching = await runtimeConnectionRows(context);
      for (const item of availability) {
        const definition = cliIntegrationAppDefinition(item.appId);
        if (!definition) continue;
        for (const field of definition.credentialFields) delete filtered[field.envName];
        if (!item.available) continue;
        const row = matching
          .filter((candidate) => candidate.app_id === item.appId && candidate.status === "active")
          .sort(
            (left, right) =>
              Number(left.owner_user_id !== context.currentUserId) -
              Number(right.owner_user_id !== context.currentUserId),
          )[0];
        if (!row) continue;
        const credential = await params.db
          .selectFrom("agent_environment_variables")
          .select("value")
          .where("id", "=", row.credential_variable_id)
          .where("user_id", "=", row.owner_user_id)
          .executeTakeFirst();
        if (credential) {
          const value = credential.value.startsWith("enc:")
            ? decrypt(credential.value, params.encryptionKey ?? "")
            : credential.value;
          filtered[definition.credentialFields[0].envName] = value;
        }
      }
      return filtered;
    },
  };
}
