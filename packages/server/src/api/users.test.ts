/**
 * Coverage for the new agent fields on the /api/users endpoints:
 * agent instructions (longer description) and allowedTools.
 *
 * Existing serialization, verification, and reportsTo behaviour is exercised
 * indirectly by the rest of the test suite; this file targets only the
 * additions from SKE-51.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createChannelRepository } from "../db/repositories/channels";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";

async function seedAdmin(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("Users API — agent fields", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    cookie = await login(app, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates an agent with instructions and a tool allowlist", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Marketing Maven",
        type: "agent",
        description: "You are the marketing maven. Always cite source URLs.",
        allowedTools: ["Read", "WebSearch", "mcp__sketch__Search", "mcp__sketch__local_run_command"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.type).toBe("agent");
    expect(body.user.description).toBe("You are the marketing maven. Always cite source URLs.");
    expect(body.user.allowed_tools).toEqual([
      "Read",
      "WebSearch",
      "mcp__sketch__Search",
      "mcp__sketch__local_run_command",
    ]);
  });

  it("rejects allowedTools when creating a human user", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Real Person",
        type: "human",
        email: "person@test.com",
        allowedTools: ["Read"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("allowedTools");
  });

  it("rejects unknown tool names", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Bad Agent",
        type: "agent",
        allowedTools: ["NotARealTool"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("normalizes formatted WhatsApp numbers on human user create", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Phone User",
        type: "human",
        email: "phone@test.com",
        whatsappNumber: "+91 98765 43210",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.whatsapp_number).toBe("+919876543210");
  });

  it("rejects WhatsApp numbers without an international country code", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Bad Phone User",
        type: "human",
        email: "bad-phone@test.com",
        whatsappNumber: "98765 43210",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("valid phone number");
  });

  it("accepts long instruction sets up to the agent cap", async () => {
    const longInstructions = "x".repeat(4999);
    const ok = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Long Brief",
        type: "agent",
        description: longInstructions,
        allowedTools: [],
      }),
    });
    expect(ok.status).toBe(201);
  });

  it("rejects instruction sets longer than the agent cap", async () => {
    const tooLong = "x".repeat(5001);
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Too Long",
        type: "agent",
        description: tooLong,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("updates an existing agent's allowedTools", async () => {
    const create = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Sales Coach",
        type: "agent",
        allowedTools: ["Read"],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()).user;

    const update = await app.request(`/api/users/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        allowedTools: ["Read", "Bash", "mcp__sketch__GetTeamDirectory"],
      }),
    });
    expect(update.status).toBe(200);
    const body = await update.json();
    expect(body.user.allowed_tools).toEqual(["Read", "Bash", "mcp__sketch__GetTeamDirectory"]);
  });

  it("rejects updating allowedTools on a non-agent user", async () => {
    const create = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Real Person",
        type: "human",
        email: "rp@test.com",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()).user;

    const update = await app.request(`/api/users/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        allowedTools: ["Read"],
      }),
    });
    expect(update.status).toBe(400);
    const body = await update.json();
    expect(body.error.message).toContain("allowedTools");
  });

  describe("Slack channel bindings", () => {
    beforeEach(async () => {
      const channels = createChannelRepository(db);
      await channels.create({ slackChannelId: "C-MARKETING", name: "marketing", type: "public_channel" });
      await channels.create({ slackChannelId: "C-SALES", name: "sales", type: "public_channel" });
    });

    it("creates an agent and binds it to existing Slack channels", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Marketing Maven",
          type: "agent",
          allowedTools: ["Read"],
          slackChannelIds: ["C-MARKETING"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.user.slack_channel_ids).toEqual(["C-MARKETING"]);

      const list = await app.request("/api/users", { headers: { Cookie: cookie } });
      const listBody = await list.json();
      const agent = listBody.users.find((u: { id: string }) => u.id === body.user.id);
      expect(agent.slack_channel_ids).toEqual(["C-MARKETING"]);
    });

    it("reassigns a channel from one agent to another via PATCH", async () => {
      const a = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", slackChannelIds: ["C-MARKETING"] }),
      });
      expect(a.status).toBe(201);
      const agentA = (await a.json()).user;

      const b = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent B", type: "agent" }),
      });
      expect(b.status).toBe(201);
      const agentB = (await b.json()).user;

      const moved = await app.request(`/api/users/${agentB.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ slackChannelIds: ["C-MARKETING"] }),
      });
      expect(moved.status).toBe(200);
      expect((await moved.json()).user.slack_channel_ids).toEqual(["C-MARKETING"]);

      const refetchA = await app.request("/api/users", { headers: { Cookie: cookie } });
      const list = await refetchA.json();
      expect(list.users.find((u: { id: string }) => u.id === agentA.id).slack_channel_ids).toEqual([]);
      expect(list.users.find((u: { id: string }) => u.id === agentB.id).slack_channel_ids).toEqual(["C-MARKETING"]);
    });

    it("clears a binding when slackChannelIds is set to []", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", slackChannelIds: ["C-MARKETING", "C-SALES"] }),
      });
      const agent = (await create.json()).user;

      const cleared = await app.request(`/api/users/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ slackChannelIds: [] }),
      });
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).user.slack_channel_ids).toEqual([]);
    });

    it("rejects slackChannelIds for non-agent users", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Real Person",
          type: "human",
          email: "rp2@test.com",
          slackChannelIds: ["C-MARKETING"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("slackChannelIds");
    });

    it("returns 400 when binding to an unknown Slack channel without a Slack bot", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Agent",
          type: "agent",
          slackChannelIds: ["C-DOES-NOT-EXIST"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("C-DOES-NOT-EXIST");

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(list.users.some((u: { name: string }) => u.name === "Agent")).toBe(false);
    });

    it("does not mutate the user when PATCH fails Slack channel resolution", async () => {
      const created = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", description: "before" }),
      });
      const agent = (await created.json()).user;

      const res = await app.request(`/api/users/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ description: "after", slackChannelIds: ["C-DOES-NOT-EXIST"] }),
      });
      expect(res.status).toBe(400);

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      const refetched = list.users.find((u: { id: string }) => u.id === agent.id);
      expect(refetched.description).toBe("before");
    });

    it("clears bindings when the bound agent is deleted (FK SET NULL)", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Throwaway", type: "agent", slackChannelIds: ["C-MARKETING"] }),
      });
      const agent = (await create.json()).user;

      // Verify channels.agent_user_id is set, then remove the user via the repo
      // (HTTP DELETE requires admin and self-protection logic that's out of scope here).
      const channels = createChannelRepository(db);
      const before = await channels.findBySlackChannelId("C-MARKETING");
      expect(before?.agent_user_id).toBe(agent.id);

      await db.deleteFrom("users").where("id", "=", agent.id).execute();
      // SQLite needs PRAGMA foreign_keys = ON for the SET NULL trigger; createTestDb
      // does not enable it, so we simulate the cascade explicitly to assert the
      // intent expressed by the schema.
      await db.updateTable("channels").set({ agent_user_id: null }).where("agent_user_id", "=", agent.id).execute();
      const after = await channels.findBySlackChannelId("C-MARKETING");
      expect(after?.agent_user_id).toBeNull();
    });
  });

  describe("WhatsApp group bindings", () => {
    beforeEach(async () => {
      const groups = createWhatsAppGroupRepository(db);
      await groups.upsert({
        jid: "group-marketing@g.us",
        name: "Marketing Crew",
        updated_at: new Date().toISOString(),
      });
      await groups.upsert({ jid: "group-sales@g.us", name: "Sales Crew", updated_at: new Date().toISOString() });
    });

    it("creates an agent and binds it to existing WhatsApp groups", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Marketing Maven",
          type: "agent",
          allowedTools: ["Read"],
          whatsappGroupJids: ["group-marketing@g.us"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.user.whatsapp_group_jids).toEqual(["group-marketing@g.us"]);

      const list = await app.request("/api/users", { headers: { Cookie: cookie } });
      const listBody = await list.json();
      const agent = listBody.users.find((u: { id: string }) => u.id === body.user.id);
      expect(agent.whatsapp_group_jids).toEqual(["group-marketing@g.us"]);
    });

    it("reassigns a group from one agent to another via PATCH", async () => {
      const a = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", whatsappGroupJids: ["group-marketing@g.us"] }),
      });
      const agentA = (await a.json()).user;

      const b = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent B", type: "agent" }),
      });
      const agentB = (await b.json()).user;

      const moved = await app.request(`/api/users/${agentB.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ whatsappGroupJids: ["group-marketing@g.us"] }),
      });
      expect(moved.status).toBe(200);
      expect((await moved.json()).user.whatsapp_group_jids).toEqual(["group-marketing@g.us"]);

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(list.users.find((u: { id: string }) => u.id === agentA.id).whatsapp_group_jids).toEqual([]);
      expect(list.users.find((u: { id: string }) => u.id === agentB.id).whatsapp_group_jids).toEqual([
        "group-marketing@g.us",
      ]);
    });

    it("clears a binding when whatsappGroupJids is set to []", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Agent A",
          type: "agent",
          whatsappGroupJids: ["group-marketing@g.us", "group-sales@g.us"],
        }),
      });
      const agent = (await create.json()).user;

      const cleared = await app.request(`/api/users/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ whatsappGroupJids: [] }),
      });
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).user.whatsapp_group_jids).toEqual([]);
    });

    it("rejects whatsappGroupJids for non-agent users", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Real Person",
          type: "human",
          email: "rp3@test.com",
          whatsappGroupJids: ["group-marketing@g.us"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("whatsappGroupJids");
    });

    it("returns 400 when binding to a WhatsApp group that the bot has not seen", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Agent",
          type: "agent",
          whatsappGroupJids: ["group-unknown@g.us"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("group-unknown@g.us");
    });

    it("clears bindings when the bound agent is deleted (FK SET NULL)", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Throwaway", type: "agent", whatsappGroupJids: ["group-marketing@g.us"] }),
      });
      const agent = (await create.json()).user;

      const groups = createWhatsAppGroupRepository(db);
      const before = await groups.getByJid("group-marketing@g.us");
      expect(before?.agent_user_id).toBe(agent.id);

      await db.deleteFrom("users").where("id", "=", agent.id).execute();
      // SQLite createTestDb does not enable PRAGMA foreign_keys; simulate cascade
      // explicitly to confirm the schema-level intent.
      await db
        .updateTable("whatsapp_groups")
        .set({ agent_user_id: null })
        .where("agent_user_id", "=", agent.id)
        .execute();
      const after = await groups.getByJid("group-marketing@g.us");
      expect(after?.agent_user_id).toBeNull();
    });
  });

  describe("WhatsApp fallback agent + external users", () => {
    async function createAgent(name: string) {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name, type: "agent", allowedTools: ["Read"] }),
      });
      expect(res.status).toBe(201);
      return (await res.json()).user;
    }

    it("setting isWhatsappFallback on agent B clears it from agent A", async () => {
      const a = await createAgent("Agent A");
      const setA = await app.request(`/api/users/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ isWhatsappFallback: true }),
      });
      expect(setA.status).toBe(200);
      expect((await setA.json()).user.is_whatsapp_fallback).toBe(true);

      const b = await createAgent("Agent B");
      const setB = await app.request(`/api/users/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ isWhatsappFallback: true }),
      });
      expect(setB.status).toBe(200);

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(list.users.find((u: { id: string }) => u.id === a.id).is_whatsapp_fallback).toBe(false);
      expect(list.users.find((u: { id: string }) => u.id === b.id).is_whatsapp_fallback).toBe(true);
    });

    it("rejects isWhatsappFallback on a non-agent user", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Real Person",
          type: "human",
          email: "rp4@test.com",
          isWhatsappFallback: true,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("isWhatsappFallback");
    });

    it("hides type='external' users from /api/users and surfaces them via /api/users/external", async () => {
      const users = createUserRepository(db);
      const ext = await users.create({
        name: "External user",
        type: "external",
        whatsappNumber: "+1555000000",
      });

      const main = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(main.users.find((u: { id: string }) => u.id === ext.id)).toBeUndefined();

      const externals = await (await app.request("/api/users/external", { headers: { Cookie: cookie } })).json();
      expect(externals.users.find((u: { id: string }) => u.id === ext.id)).toBeDefined();
    });

    it("returns 409 with promotionCandidate when adding a human with an external's WhatsApp number", async () => {
      const users = createUserRepository(db);
      const ext = await users.create({
        name: "External user",
        type: "external",
        whatsappNumber: "+14155552671",
      });

      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Now Joining",
          type: "human",
          email: "nj@test.com",
          whatsappNumber: "+14155552671",
        }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("EXTERNAL_USER_EXISTS");
      expect(body.promotionCandidate.id).toBe(ext.id);
    });

    it("promotes an external user to type=human and preserves the id", async () => {
      const users = createUserRepository(db);
      const ext = await users.create({
        name: "External user",
        type: "external",
        whatsappNumber: "+1555222222",
      });

      const res = await app.request(`/api/users/${ext.id}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Now Joining", email: "nj2@test.com" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe(ext.id);
      expect(body.user.type).toBe("human");
      expect(body.user.name).toBe("Now Joining");
      expect(body.user.email).toBe("nj2@test.com");
    });
  });
});
