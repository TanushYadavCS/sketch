import type { CliIntegrationAppId, CliIntegrationConnectionStatus } from "@sketch/shared";
import type { Kysely, Selectable } from "kysely";
import type { DB } from "../schema";

export type CliIntegrationConnectionRow = Selectable<DB["cli_integration_connections"]>;

export interface CreateCliIntegrationConnectionInput {
  id: string;
  appId: CliIntegrationAppId;
  ownerUserId: string;
  credentialVariableId: string;
  accountExternalId: string | null;
  accountLogin: string;
  accountAvatarUrl: string | null;
  accountType: string | null;
  status: CliIntegrationConnectionStatus;
  verifiedAt: string;
  lastVerificationError: string | null;
}

export function createCliIntegrationConnectionsRepository(db: Kysely<DB>) {
  return {
    async findById(id: string) {
      return (
        (await db.selectFrom("cli_integration_connections").selectAll().where("id", "=", id).executeTakeFirst()) ?? null
      );
    },

    async findByIdAndOwner(id: string, ownerUserId: string) {
      return (
        (await db
          .selectFrom("cli_integration_connections")
          .selectAll()
          .where("id", "=", id)
          .where("owner_user_id", "=", ownerUserId)
          .executeTakeFirst()) ?? null
      );
    },

    async findByOwnerAndApp(ownerUserId: string, appId: CliIntegrationAppId) {
      return (
        (await db
          .selectFrom("cli_integration_connections")
          .selectAll()
          .where("owner_user_id", "=", ownerUserId)
          .where("app_id", "=", appId)
          .executeTakeFirst()) ?? null
      );
    },

    async findByCredentialVariableId(credentialVariableId: string) {
      return (
        (await db
          .selectFrom("cli_integration_connections")
          .selectAll()
          .where("credential_variable_id", "=", credentialVariableId)
          .executeTakeFirst()) ?? null
      );
    },

    async listForOwner(ownerUserId: string) {
      return db
        .selectFrom("cli_integration_connections")
        .selectAll()
        .where("owner_user_id", "=", ownerUserId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async listForViewer(viewerUserId: string, targetContext?: { slackChannelId?: string; whatsappGroupJid?: string }) {
      const targetTypes = [
        ...(targetContext ? [] : [{ type: "user", id: viewerUserId }]),
        { type: "org", id: "default" },
        ...(targetContext?.slackChannelId ? [{ type: "slack_channel", id: targetContext.slackChannelId }] : []),
        ...(targetContext?.whatsappGroupJid ? [{ type: "whatsapp_group", id: targetContext.whatsappGroupJid }] : []),
      ];
      return db
        .selectFrom("cli_integration_connections as c")
        .selectAll("c")
        .where((eb) =>
          eb.or([
            ...(targetContext ? [] : [eb("c.owner_user_id", "=", viewerUserId)]),
            ...targetTypes.map((target) =>
              eb.exists(
                eb
                  .selectFrom("agent_environment_variable_shares as s")
                  .select("s.id")
                  .whereRef("s.variable_id", "=", "c.credential_variable_id")
                  .where("s.target_type", "=", target.type)
                  .where("s.target_id", "=", target.id),
              ),
            ),
          ]),
        )
        .orderBy("c.created_at", "asc")
        .execute();
    },

    async create(input: CreateCliIntegrationConnectionInput, executor: Kysely<DB> = db) {
      await executor
        .insertInto("cli_integration_connections")
        .values({
          id: input.id,
          app_id: input.appId,
          owner_user_id: input.ownerUserId,
          credential_variable_id: input.credentialVariableId,
          account_external_id: input.accountExternalId,
          account_login: input.accountLogin,
          account_avatar_url: input.accountAvatarUrl,
          account_type: input.accountType,
          status: input.status,
          verified_at: input.verifiedAt,
          last_verification_error: input.lastVerificationError,
        })
        .execute();
      return executor
        .selectFrom("cli_integration_connections")
        .selectAll()
        .where("id", "=", input.id)
        .executeTakeFirstOrThrow();
    },

    async updateVerification(
      id: string,
      ownerUserId: string,
      input: {
        accountExternalId: string | null;
        accountLogin: string;
        accountAvatarUrl: string | null;
        accountType: string | null;
        status: CliIntegrationConnectionStatus;
        verifiedAt: string;
        lastVerificationError: string | null;
      },
      executor: Kysely<DB> = db,
    ) {
      await executor
        .updateTable("cli_integration_connections")
        .set({
          account_external_id: input.accountExternalId,
          account_login: input.accountLogin,
          account_avatar_url: input.accountAvatarUrl,
          account_type: input.accountType,
          status: input.status,
          verified_at: input.verifiedAt,
          last_verification_error: input.lastVerificationError,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", id)
        .where("owner_user_id", "=", ownerUserId)
        .execute();
      return (
        (await executor
          .selectFrom("cli_integration_connections")
          .selectAll()
          .where("id", "=", id)
          .where("owner_user_id", "=", ownerUserId)
          .executeTakeFirst()) ?? null
      );
    },

    async markInvalid(id: string, ownerUserId: string, message: string, executor: Kysely<DB> = db) {
      await executor
        .updateTable("cli_integration_connections")
        .set({ status: "invalid", last_verification_error: message, updated_at: new Date().toISOString() })
        .where("id", "=", id)
        .where("owner_user_id", "=", ownerUserId)
        .execute();
      return (
        (await executor
          .selectFrom("cli_integration_connections")
          .selectAll()
          .where("id", "=", id)
          .where("owner_user_id", "=", ownerUserId)
          .executeTakeFirst()) ?? null
      );
    },

    async delete(id: string, ownerUserId: string, executor: Kysely<DB> = db) {
      const result = await executor
        .deleteFrom("cli_integration_connections")
        .where("id", "=", id)
        .where("owner_user_id", "=", ownerUserId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
