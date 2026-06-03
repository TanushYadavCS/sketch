import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import type { EmailAddr, NormalizedEmailEnvelope } from "./normalized-email";

export async function persistEnvelopeMetadata(
  db: Kysely<DB>,
  indexedFileId: string,
  envelope: NormalizedEmailEnvelope,
): Promise<void> {
  const values = {
    indexed_file_id: indexedFileId,
    connector_config_id: envelope.connectorConfigId,
    provider_file_id: envelope.providerFileId,
    provider_message_id: envelope.providerMessageId,
    thread_id: envelope.threadId,
    subject: envelope.subject,
    sent_at: envelope.sentAt,
    from_json: JSON.stringify(envelope.from),
    to_json: JSON.stringify(envelope.to),
    cc_json: JSON.stringify(envelope.cc),
    owner_email: envelope.ownerEmail,
    provider_url: envelope.providerUrl,
    updated_at: new Date().toISOString(),
  };

  await db
    .insertInto("email_message_envelopes")
    .values(values)
    .onConflict((oc) =>
      oc.column("indexed_file_id").doUpdateSet({
        connector_config_id: values.connector_config_id,
        provider_file_id: values.provider_file_id,
        provider_message_id: values.provider_message_id,
        thread_id: values.thread_id,
        subject: values.subject,
        sent_at: values.sent_at,
        from_json: values.from_json,
        to_json: values.to_json,
        cc_json: values.cc_json,
        owner_email: values.owner_email,
        provider_url: values.provider_url,
        updated_at: values.updated_at,
      }),
    )
    .execute();
}

export function parseEmailAddrJson(value: string): EmailAddr {
  return JSON.parse(value) as EmailAddr;
}

export function parseEmailAddrListJson(value: string): EmailAddr[] {
  return JSON.parse(value) as EmailAddr[];
}
