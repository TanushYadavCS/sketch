import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { encrypt } from "../auth/encryption";
import type { DB } from "./schema";

export async function backfillFilesConnectorCredentialEncryption(
  db: Kysely<DB>,
  encryptionKey: string | undefined,
  logger?: Pick<Logger, "info">,
): Promise<{ connectorCredentials: number; providerIdentityTokenFields: number }> {
  if (!encryptionKey) {
    return { connectorCredentials: 0, providerIdentityTokenFields: 0 };
  }

  let connectorCredentials = 0;
  const connectorRows = await db.selectFrom("connector_configs").select(["id", "credentials"]).execute();
  for (const row of connectorRows) {
    if (row.credentials.startsWith("enc:")) continue;
    await db
      .updateTable("connector_configs")
      .set({ credentials: encrypt(row.credentials, encryptionKey) })
      .where("id", "=", row.id)
      .execute();
    connectorCredentials++;
  }

  let providerIdentityTokenFields = 0;
  const identityRows = await db
    .selectFrom("user_provider_identities")
    .select(["id", "access_token", "refresh_token"])
    .execute();
  for (const row of identityRows) {
    const updates: { access_token?: string; refresh_token?: string } = {};
    if (row.access_token && !row.access_token.startsWith("enc:")) {
      updates.access_token = encrypt(row.access_token, encryptionKey);
      providerIdentityTokenFields++;
    }
    if (row.refresh_token && !row.refresh_token.startsWith("enc:")) {
      updates.refresh_token = encrypt(row.refresh_token, encryptionKey);
      providerIdentityTokenFields++;
    }
    if (Object.keys(updates).length > 0) {
      await db.updateTable("user_provider_identities").set(updates).where("id", "=", row.id).execute();
    }
  }

  if (connectorCredentials > 0) {
    logger?.info({ count: connectorCredentials }, "Encrypted legacy connector credential rows");
  }
  if (providerIdentityTokenFields > 0) {
    logger?.info({ count: providerIdentityTokenFields }, "Encrypted legacy provider identity token fields");
  }

  return { connectorCredentials, providerIdentityTokenFields };
}
