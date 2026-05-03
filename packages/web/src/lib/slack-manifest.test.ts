import { describe, expect, it } from "vitest";
import { generateSlackManifest } from "./slack-manifest";

describe("generateSlackManifest", () => {
  it("returns valid JSON string", () => {
    const manifest = generateSlackManifest();
    expect(() => JSON.parse(manifest)).not.toThrow();
  });

  it('uses "Sketch" as default bot name', () => {
    const manifest = generateSlackManifest();
    const parsed = JSON.parse(manifest);
    expect(parsed.display_information.name).toBe("Sketch");
    expect(parsed.features.bot_user.display_name).toBe("Sketch");
  });

  it("uses custom bot name when provided", () => {
    const manifest = generateSlackManifest("MyBot");
    const parsed = JSON.parse(manifest);
    expect(parsed.display_information.name).toBe("MyBot");
    expect(parsed.features.bot_user.display_name).toBe("MyBot");
  });

  it("trims whitespace from bot name", () => {
    const manifest = generateSlackManifest("  MyBot  ");
    const parsed = JSON.parse(manifest);
    expect(parsed.display_information.name).toBe("MyBot");
    expect(parsed.features.bot_user.display_name).toBe("MyBot");
  });

  it('falls back to "Sketch" for empty string', () => {
    const manifest = generateSlackManifest("");
    const parsed = JSON.parse(manifest);
    expect(parsed.display_information.name).toBe("Sketch");
  });

  it('falls back to "Sketch" for whitespace-only string', () => {
    const manifest = generateSlackManifest("   ");
    const parsed = JSON.parse(manifest);
    expect(parsed.display_information.name).toBe("Sketch");
  });

  it("includes users:read.email scope", () => {
    const manifest = generateSlackManifest();
    const parsed = JSON.parse(manifest);
    expect(parsed.oauth_config.scopes.bot).toContain("users:read.email");
  });

  it("includes all required scopes", () => {
    const manifest = generateSlackManifest();
    const parsed = JSON.parse(manifest);
    const scopes = parsed.oauth_config.scopes.bot;

    expect(scopes).toContain("app_mentions:read");
    expect(scopes).toContain("channels:history");
    expect(scopes).toContain("channels:read");
    expect(scopes).toContain("chat:write");
    expect(scopes).toContain("groups:history");
    expect(scopes).toContain("groups:read");
    expect(scopes).toContain("im:history");
    expect(scopes).toContain("im:read");
    expect(scopes).toContain("im:write");
    expect(scopes).toContain("mpim:history");
    expect(scopes).toContain("mpim:read");
    expect(scopes).toContain("reactions:read");
    expect(scopes).toContain("reactions:write");
    expect(scopes).toContain("team:read");
    expect(scopes).toContain("users:read");
    expect(scopes).toContain("files:read");
    expect(scopes).toContain("files:write");
    expect(scopes).toContain("assistant:write");
  });

  it("does not include scopes without handlers", () => {
    const manifest = generateSlackManifest();
    const parsed = JSON.parse(manifest);
    expect(parsed.oauth_config.scopes.bot).not.toContain("commands");
  });

  it("includes all required bot events", () => {
    const manifest = generateSlackManifest();
    const parsed = JSON.parse(manifest);
    const events = parsed.settings.event_subscriptions.bot_events;

    expect(events).toContain("app_mention");
    expect(events).toContain("app_home_opened");
    expect(events).toContain("assistant_thread_started");
    expect(events).toContain("assistant_thread_context_changed");
    expect(events).toContain("message.channels");
    expect(events).toContain("message.groups");
    expect(events).toContain("message.im");
    expect(events).toContain("message.mpim");
  });

  it("enables App Home tab and Assistant view", () => {
    const manifest = generateSlackManifest();
    const parsed = JSON.parse(manifest);

    expect(parsed.features.app_home.home_tab_enabled).toBe(true);
    expect(parsed.features.app_home.messages_tab_enabled).toBe(true);
    expect(parsed.features.app_home.messages_tab_read_only_enabled).toBe(false);
    expect(typeof parsed.features.assistant_view.assistant_description).toBe("string");
  });

  it("sets correct settings", () => {
    const manifest = generateSlackManifest();
    const parsed = JSON.parse(manifest);

    expect(parsed.settings.socket_mode_enabled).toBe(true);
    expect(parsed.settings.token_rotation_enabled).toBe(false);
    expect(parsed.settings.org_deploy_enabled).toBe(false);
    expect(parsed.settings.interactivity.is_enabled).toBe(true);
  });

  it("returns pretty-printed JSON (2-space indent)", () => {
    const manifest = generateSlackManifest();
    expect(manifest).toContain("\n  "); // 2-space indent
  });
});
