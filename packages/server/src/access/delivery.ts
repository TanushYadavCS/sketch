import type { Kysely } from "kysely";
import type { SearchableUserRepo } from "../agent/tools/types";
import type { DB } from "../db/schema";
import type { WorkflowDelivery } from "../workflows/delivery";
import { authorizedTargets } from "./membership";
import { resolveViewerPrincipals } from "./principals";

export function isSharedDeliveryTarget(targetType: WorkflowDelivery["targetType"]): boolean {
  return targetType === "channel" || targetType === "group" || targetType === "thread";
}

export async function deliveryAuthorizationError(params: {
  db: Kysely<DB>;
  userRepo?: SearchableUserRepo;
  userId: string | null | undefined;
  delivery: Pick<WorkflowDelivery, "platform" | "targetType" | "targetId">;
}): Promise<string | null> {
  if (!isSharedDeliveryTarget(params.delivery.targetType)) return null;

  const principals =
    params.userId && params.userRepo
      ? await resolveViewerPrincipals({
          db: params.db,
          currentUserId: params.userId,
          userRepo: params.userRepo,
        }).catch(() => [])
      : [];
  const authorized = await authorizedTargets(params.db, principals, [
    { platform: params.delivery.platform, targetId: params.delivery.targetId },
  ]);
  if (authorized.has(`${params.delivery.platform}:${params.delivery.targetId}`)) return null;

  const targetLabel = params.delivery.targetType === "thread" ? "channel or group" : params.delivery.targetType;
  return `Error: delivery target ${params.delivery.targetId} is not authorized because the requester is not a member of this ${targetLabel}. No changes were saved.`;
}
