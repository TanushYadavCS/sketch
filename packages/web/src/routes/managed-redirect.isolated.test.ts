import { describe, expect, it, vi } from "vitest";
import { managedLoginUrl, managedSlackAuthorizationUrl, redirectToManagedLogin } from "./managed-redirect";

const redirect = vi.hoisted(() => vi.fn((options: unknown) => ({ options })));

vi.mock("@tanstack/react-router", () => ({ redirect }));

describe("managed redirect helpers", () => {
  it("builds the platform login URL without duplicate slashes", () => {
    expect(managedLoginUrl("https://app.getsketch.ai")).toBe("https://app.getsketch.ai/login");
    expect(managedLoginUrl("https://app.getsketch.ai/")).toBe("https://app.getsketch.ai/login");
    expect(managedLoginUrl("https://app.getsketch.ai/platform/")).toBe("https://app.getsketch.ai/platform/login");
  });

  it("preserves a return target when provided", () => {
    expect(managedLoginUrl("https://app.getsketch.ai", "/integrations?connect=github")).toBe(
      "https://app.getsketch.ai/login?return_to=%2Fintegrations%3Fconnect%3Dgithub",
    );
  });

  it("builds a managed Slack authorization URL with an absolute tenant return target", () => {
    expect(managedSlackAuthorizationUrl("https://app.getsketch.ai/", "https://acme.getsketch.ai/channels")).toBe(
      "https://app.getsketch.ai/api/slack/connections/authorization?return_to=https%3A%2F%2Facme.getsketch.ai%2Fchannels",
    );
  });

  it("throws an external router redirect to the managed login URL", () => {
    expect(() => redirectToManagedLogin("https://app.getsketch.ai")).toThrow();
    expect(redirect).toHaveBeenCalledWith({ href: "https://app.getsketch.ai/login" });
  });
});
