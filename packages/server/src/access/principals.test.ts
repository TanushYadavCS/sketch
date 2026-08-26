import { describe, expect, it } from "vitest";
import { resolveMembershipPrincipals } from "./principals";

function userRepo(verifiedEmails: string[]) {
  return {
    list: async () => [],
    findById: async () =>
      ({
        id: "user-1",
        email: "unverified@example.com",
        whatsapp_number: null,
        slack_user_id: null,
        whatsapp_lid: null,
        auth_role: "member",
      }) as never,
    getAllEmailsForUser: async () => ["unverified@example.com"],
    getVerifiedEmailsForUser: async () => verifiedEmails,
  };
}

describe("resolveMembershipPrincipals", () => {
  it("does not resolve an unverified primary email as an authorization principal", async () => {
    const principals = await resolveMembershipPrincipals({
      currentUserId: "user-1",
      userRepo: userRepo([]),
    });

    expect(principals).not.toContainEqual({ type: "email", value: "unverified@example.com" });
  });

  it("resolves a verified email as an authorization principal", async () => {
    const principals = await resolveMembershipPrincipals({
      currentUserId: "user-1",
      userRepo: userRepo(["verified@example.com"]),
    });

    expect(principals).toContainEqual({ type: "email", value: "verified@example.com" });
  });
});
