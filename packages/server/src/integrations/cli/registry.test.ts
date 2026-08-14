import {
  cliIntegrationAppDefinition,
  isCanvasBlockedCliAppId,
  isCanvasBlockedCliComponentKey,
  parseCliSkillFrontmatter,
} from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { isCanvasBlockedConnectionId } from "./policy";
import { getCliIntegrationDefinition, listCliIntegrationDefinitions } from "./registry";

describe("CLI integration registry", () => {
  it("defines GitHub as a managed gh integration", () => {
    expect(cliIntegrationAppDefinition(" GitHub ")).toMatchObject({
      id: "github",
      skillId: "github",
      executable: "gh",
      credentialFields: [{ envName: "GH_TOKEN", secret: true, inputType: "password" }],
    });
    expect(getCliIntegrationDefinition("github")?.name).toBe("GitHub");
    expect(listCliIntegrationDefinitions("git")).toHaveLength(1);
  });

  it("parses provider-gated skill frontmatter with list and scalar env forms", () => {
    expect(parseCliSkillFrontmatter({ "provider-type": "cli:github", "requires-env": ["GH_TOKEN"] })).toEqual({
      providerType: "cli:github",
      requiresEnv: ["GH_TOKEN"],
    });
    expect(parseCliSkillFrontmatter({ providerType: "cli:github", requiresEnv: "GH_TOKEN, API_TOKEN" })).toEqual({
      providerType: "cli:github",
      requiresEnv: ["GH_TOKEN", "API_TOKEN"],
    });
  });

  it("blocks managed GitHub and Linear apps and component keys from Canvas", () => {
    expect(isCanvasBlockedCliAppId("github-oauth")).toBe(true);
    expect(isCanvasBlockedCliAppId("linear")).toBe(true);
    expect(isCanvasBlockedCliAppId("linear-oauth")).toBe(true);
    expect(isCanvasBlockedCliAppId("linear_app")).toBe(true);
    expect(isCanvasBlockedCliComponentKey("github-create-issue")).toBe(true);
    expect(isCanvasBlockedCliComponentKey("github")).toBe(true);
    expect(isCanvasBlockedCliComponentKey("linear-create-issue")).toBe(true);
    expect(isCanvasBlockedCliComponentKey("linear")).toBe(true);
  });

  it("recognizes managed aliases embedded in Canvas connection IDs", () => {
    expect(isCanvasBlockedConnectionId("secrets:owner-1:github:github")).toBe(true);
    expect(isCanvasBlockedConnectionId("apn_github_1")).toBe(true);
    expect(isCanvasBlockedConnectionId("secrets:owner-1:linear:linear")).toBe(true);
    expect(isCanvasBlockedConnectionId("apn_linear_1")).toBe(true);
  });
});
