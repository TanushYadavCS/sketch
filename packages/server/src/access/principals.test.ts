import { describe, expect, it } from "vitest";
import { resolveViewerPrincipals } from "./principals";

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
      }) as never,
    getAllEmailsForUser: async () => ["unverified@example.com"],
    getVerifiedEmailsForUser: async () => verifiedEmails,
  };
}

describe("resolveViewerPrincipals", () => {
  it("does not resolve an unverified primary email as an authorization principal", async () => {
    const principals = await resolveViewerPrincipals({
      currentUserId: "user-1",
      userRepo: userRepo([]),
    });

    expect(principals).not.toContainEqual({ type: "email", value: "unverified@example.com" });
  });

  it("resolves a verified email as an authorization principal", async () => {
    const principals = await resolveViewerPrincipals({
      currentUserId: "user-1",
      userRepo: userRepo(["verified@example.com"]),
    });

    expect(principals).toContainEqual({ type: "email", value: "verified@example.com" });
  });
});
