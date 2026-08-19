import type { SketchMcpDeps } from "../agent/tools/types";
import type { AccessPrincipal } from "../connectors/types";
import { normalizeAccessPrincipals } from "../connectors/types";
import { viewerPrincipals } from "../db/repositories/connectors";
import { getWhatsAppLidsForUser } from "../db/repositories/user-whatsapp-lids";

export type ViewerPrincipalDeps = Pick<
  SketchMcpDeps,
  "db" | "currentUserId" | "userRepo" | "slackEntitySyncEnabled" | "publicMcp"
>;

export async function resolveViewerPrincipals(deps: ViewerPrincipalDeps): Promise<AccessPrincipal[]> {
  if (deps.publicMcp?.userPrincipals) return normalizeAccessPrincipals(deps.publicMcp.userPrincipals);
  if (!deps.currentUserId || !deps.userRepo?.findById || !deps.userRepo.getAllEmailsForUser) return [];
  const user = await deps.userRepo.findById(deps.currentUserId);
  if (!user) return [];
  const emails = await deps.userRepo.getAllEmailsForUser(deps.currentUserId);
  return viewerPrincipals({
    email: user.email,
    emails,
    phone: user.whatsapp_number,
    slackUserId: user.slack_user_id,
    whatsappLid: user.whatsapp_lid,
    whatsappLids: deps.db ? await getWhatsAppLidsForUser(deps.db, user.id) : [],
    isAdmin: false,
    slackEntitySyncEnabled: deps.slackEntitySyncEnabled,
  });
}
