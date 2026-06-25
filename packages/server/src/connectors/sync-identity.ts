import type { ConnectorType, SyncedItem } from "./types";

export type SyncIdentity =
  | { kind: "provider_message_id"; connectorConfigId: string; providerMessageId: string }
  | { kind: "provider_file_id"; source: string; providerFileId: string; connectorConfigId?: string };

export interface SyncIdentityInput {
  connectorConfigId: string;
  connectorType: ConnectorType | string;
  providerFileId: string;
  providerMessageId?: string | null;
}

export function getSyncIdentityForItem(
  item: SyncedItem,
  connectorConfigId: string,
  connectorType: ConnectorType,
): SyncIdentity {
  return getSyncIdentity({
    connectorConfigId,
    connectorType,
    providerFileId: item.providerFileId,
    providerMessageId: item.providerMessageId,
  });
}

export function getSyncIdentity(input: SyncIdentityInput): SyncIdentity {
  if (input.providerMessageId) {
    return {
      kind: "provider_message_id",
      connectorConfigId: input.connectorConfigId,
      providerMessageId: input.providerMessageId,
    };
  }

  if (input.connectorType === "teams") {
    return {
      kind: "provider_file_id",
      connectorConfigId: input.connectorConfigId,
      source: input.connectorType,
      providerFileId: input.providerFileId,
    };
  }

  return {
    kind: "provider_file_id",
    source: input.connectorType,
    providerFileId: input.providerFileId,
  };
}

export function syncIdentityKey(identity: SyncIdentity): string {
  if (identity.kind === "provider_message_id") {
    return `provider_message_id:${identity.connectorConfigId}:${identity.providerMessageId}`;
  }

  if (identity.connectorConfigId) {
    return `provider_file_id:${identity.connectorConfigId}:${identity.source}:${identity.providerFileId}`;
  }

  return `provider_file_id:${identity.source}:${identity.providerFileId}`;
}
