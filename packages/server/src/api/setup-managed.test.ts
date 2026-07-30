import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { setupRoutes } from "./setup";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

function createTestSetupApp(
  settings: SettingsRepo,
  deps?: {
    managedUrl?: string;
    slackMode?: "socket" | "http";
    userRepo?: ReturnType<typeof createUserRepository>;
  },
) {
  const app = new Hono();
  app.route("/api/setup", setupRoutes(settings, deps));
  return app;
}

describe("GET /api/setup/status", () => {
  let db: Kysely<DB>;
  let settings: SettingsRepo;

  beforeEach(async () => {
    db = await createTestDb();
    settings = createSettingsRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("self-hosted mode (no managedUrl)", () => {
    it("returns currentStep 0 when no admin exists", async () => {
      const app = createTestSetupApp(settings);
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(0);
    });

    it("returns currentStep 2 when admin exists", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      const app = createTestSetupApp(settings);
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(2);
    });

    it("returns currentStep 3 when admin and identity are set", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ orgName: "Acme", botName: "Sketch" });
      const app = createTestSetupApp(settings);
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(3);
    });

    it("does not report Slack connected when only a bot token is configured", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ slackBotToken: "xoxb-test" });
      const app = createTestSetupApp(settings);
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.slackConnected).toBe(false);
    });

    it("reports bot-only Slack connected in HTTP mode", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ slackBotToken: "xoxb-test" });
      const app = createTestSetupApp(settings, { slackMode: "http" });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.slackConnected).toBe(true);
    });

    it("returns currentStep 4 when admin, identity, and slack are set", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ orgName: "Acme", botName: "Sketch" });
      await settings.update({ slackBotToken: "xoxb-test", slackAppToken: "xapp-test" });
      const app = createTestSetupApp(settings);
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(4);
    });

    it("returns currentStep 5 when all steps are complete", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ orgName: "Acme", botName: "Sketch" });
      await settings.update({ slackBotToken: "xoxb-test", slackAppToken: "xapp-test" });
      await settings.update({ llmProvider: "anthropic", anthropicApiKey: "sk-ant-test" });
      const app = createTestSetupApp(settings);
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(5);
    });
  });

  describe("managed mode (managedUrl set)", () => {
    const managedUrl = "https://managed.example.com";

    it("returns currentStep 2 (Identity) when admin is pre-seeded, skipping Account step", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      const app = createTestSetupApp(settings, { managedUrl });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(2);
    });

    it("returns currentStep 4 (LLM) when admin and identity are set, skipping Slack step", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ orgName: "Acme", botName: "Sketch" });
      const app = createTestSetupApp(settings, { managedUrl });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(4);
    });

    it("returns currentStep 5 (complete) when admin, identity, and LLM are set, without requiring Slack", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ orgName: "Acme", botName: "Sketch" });
      await settings.update({ llmProvider: "anthropic", anthropicApiKey: "sk-ant-test" });
      const app = createTestSetupApp(settings, { managedUrl });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(5);
      expect(body.readyToComplete).toBe(true);
    });

    it("reports a passwordless managed admin as ready", async () => {
      await settings.create();
      const userRepo = createUserRepository(db);
      await userRepo.create({
        name: "Admin",
        email: "admin@test.com",
        emailVerified: true,
        passwordHash: null,
        authRole: "admin",
      });
      await settings.update({
        orgName: "Acme",
        botName: "Sketch",
        llmProvider: "anthropic",
        anthropicApiKey: "sk-ant-test",
      });
      const app = createTestSetupApp(settings, { managedUrl, userRepo });

      const res = await app.request("/api/setup/status");
      const body = await res.json();

      expect(body.currentStep).toBe(5);
      expect(body.readyToComplete).toBe(true);
      expect(body.adminEmail).toBe("admin@test.com");
    });

    it("completes setup for a passwordless managed admin", async () => {
      await settings.create();
      const userRepo = createUserRepository(db);
      await userRepo.create({
        name: "Admin",
        email: "admin@test.com",
        emailVerified: true,
        passwordHash: null,
        authRole: "admin",
      });
      const app = createTestSetupApp(settings, { managedUrl, userRepo });

      const res = await app.request("/api/setup/complete", { method: "POST" });

      expect(res.status).toBe(200);
      expect((await settings.get())?.onboarding_completed_at).not.toBeNull();
    });

    it("does not report ready when an LLM exists without admin or identity", async () => {
      await settings.create();
      await settings.update({ llmProvider: "anthropic", anthropicApiKey: "sk-ant-test" });
      const app = createTestSetupApp(settings, { managedUrl });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.currentStep).toBe(0);
      expect(body.readyToComplete).toBe(false);
    });

    it("treats a managed HTTP bot token as a connected Slack installation", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ slackBotToken: "xoxb-test" });
      const app = createTestSetupApp(settings, { managedUrl, slackMode: "http" });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.slackConnected).toBe(true);
    });

    it("requires an app token for managed Socket Mode", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      await settings.update({ slackBotToken: "xoxb-test" });
      const app = createTestSetupApp(settings, { managedUrl, slackMode: "socket" });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.slackConnected).toBe(false);
    });
  });

  describe("managedUrl field in response", () => {
    it("includes managedUrl in response when in managed mode", async () => {
      await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash" });
      const managedUrl = "https://managed.example.com";
      const app = createTestSetupApp(settings, { managedUrl });
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body.managedUrl).toBe(managedUrl);
    });

    it("does not include managedUrl in response when in self-hosted mode", async () => {
      const app = createTestSetupApp(settings);
      const res = await app.request("/api/setup/status");
      const body = await res.json();
      expect(body).not.toHaveProperty("managedUrl");
    });
  });
});
