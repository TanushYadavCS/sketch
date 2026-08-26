import type { SketchMcpDeps } from "../agent/tools/types";
import type { AccessPrincipal } from "../connectors/types";
import { normalizeAccessPrincipals } from "../connectors/types";
import { viewerPrincipals } from "../db/repositories/connectors";
import { getWhatsAppLidsForUser } from "../db/repositories/user-whatsapp-lids";

export type MembershipPrincipalDeps = Pick<
  SketchMcpDeps,
  "db" | "currentUserId" | "userRepo" | "slackEntitySyncEnabled" | "publicMcp"
>;

export type ContentPrincipalDeps = MembershipPrincipalDeps & {
  adminBypass: { enabled: boolean };
};

export async function resolveMembershipPrincipals(deps: MembershipPrincipalDeps): Promise<AccessPrincipal[]> {
  if (deps.publicMcp?.userPrincipals) return normalizeAccessPrincipals(deps.publicMcp.userPrincipals);
  if (!deps.currentUserId || !deps.userRepo?.findById || !deps.userRepo.getVerifiedEmailsForUser) {
    return [];
  }
  const user = await deps.userRepo.findById(deps.currentUserId);
  if (!user) return [];
  const emails = await deps.userRepo.getVerifiedEmailsForUser(deps.currentUserId);
  return viewerPrincipals({
    email: null,
    emails,
    phone: user.whatsapp_number,
    slackUserId: user.slack_user_id,
    whatsappLid: user.whatsapp_lid,
    whatsappLids: deps.db ? await getWhatsAppLidsForUser(deps.db, user.id) : [],
    isAdmin: false,
    slackEntitySyncEnabled: deps.slackEntitySyncEnabled,
  });
}

export async function resolveContentPrincipals(deps: ContentPrincipalDeps): Promise<AccessPrincipal[] | undefined> {
  if (deps.publicMcp?.userPrincipals) return normalizeAccessPrincipals(deps.publicMcp.userPrincipals);
  if (!deps.currentUserId || !deps.userRepo?.findById) return [];

  const user = await deps.userRepo.findById(deps.currentUserId);
  if (!user) return [];
  if (!deps.publicMcp && deps.adminBypass.enabled && user.auth_role === "admin") return undefined;
  if (!deps.userRepo.getVerifiedEmailsForUser) return [];

  const emails = await deps.userRepo.getVerifiedEmailsForUser(deps.currentUserId);
  return viewerPrincipals({
    email: null,
    emails,
    phone: user.whatsapp_number,
    slackUserId: user.slack_user_id,
    whatsappLid: user.whatsapp_lid,
    whatsappLids: deps.db ? await getWhatsAppLidsForUser(deps.db, user.id) : [],
    isAdmin: false,
    slackEntitySyncEnabled: deps.slackEntitySyncEnabled,
  });
}
