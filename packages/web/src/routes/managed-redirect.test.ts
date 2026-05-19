import { describe, expect, it, vi } from "vitest";
import { managedLoginUrl, redirectToManagedLogin } from "./managed-redirect";

const redirect = vi.hoisted(() => vi.fn((options: unknown) => ({ options })));

vi.mock("@tanstack/react-router", () => ({ redirect }));

describe("managed redirect helpers", () => {
  it("builds the platform login URL without duplicate slashes", () => {
    expect(managedLoginUrl("https://app.getsketch.ai")).toBe("https://app.getsketch.ai/login");
    expect(managedLoginUrl("https://app.getsketch.ai/")).toBe("https://app.getsketch.ai/login");
  });

  it("throws an external router redirect to the managed login URL", () => {
    expect(() => redirectToManagedLogin("https://app.getsketch.ai")).toThrow();
    expect(redirect).toHaveBeenCalledWith({ href: "https://app.getsketch.ai/login" });
  });
});
