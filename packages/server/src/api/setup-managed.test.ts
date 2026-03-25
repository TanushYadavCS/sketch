import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { setupRoutes } from "./setup";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

function createTestSetupApp(settings: SettingsRepo, deps?: { managedUrl?: string }) {
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
