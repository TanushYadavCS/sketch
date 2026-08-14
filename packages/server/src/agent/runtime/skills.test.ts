import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams } from "../runner";
import { createAgentRuntimeWorkspaceToolScopePolicy } from "./path-guard";
import {
  DefaultAgentRuntimeSkillsProvider,
  discoverAgentRuntimeSkills,
  formatAgentRuntimeSkillPrompt,
  loadAgentRuntimeClaudeMdContext,
  parseAgentRuntimeSkillMarkdown,
  prependClaudeMdContext,
} from "./skills";
import { createAgentRuntimeWorkspaceTools } from "./workspace-tools";

async function writeSkill(root: string, id: string, content: string): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf-8");
  return dir;
}

async function executeTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const selectedTool = tools[name] as
    | {
        execute?: (
          input: unknown,
          options: { toolCallId: string; messages: ModelMessage[]; context: undefined },
        ) => unknown;
      }
    | undefined;
  if (!selectedTool?.execute) throw new Error(`Tool is not executable: ${name}`);
  return await selectedTool.execute(input, {
    toolCallId: "tool-call-test",
    messages: [],
    context: undefined,
  });
}

function runParams(params: {
  workspaceDir: string;
  claudeConfigDir?: string | null;
  agentAllowedTools?: string[] | null;
  agentEnv?: Record<string, string>;
  agentSkillIds?: string[] | null;
}): RunAgentParams {
  return {
    workspaceDir: params.workspaceDir,
    claudeConfigDir: params.claudeConfigDir ?? undefined,
    agentAllowedTools: params.agentAllowedTools,
    agentEnv: params.agentEnv,
    agentSkillIds: params.agentSkillIds,
  } as RunAgentParams;
}

describe("agent runtime skills", () => {
  let root: string;
  let workspaceDir: string;
  let orgClaudeDir: string;
  let orgSkillsDir: string;
  let workspaceSkillsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sketch-runtime-skills-"));
    workspaceDir = join(root, "workspace");
    orgClaudeDir = join(root, "claude");
    orgSkillsDir = join(orgClaudeDir, "skills");
    workspaceSkillsDir = join(workspaceDir, ".claude", "skills");
    await mkdir(orgSkillsDir, { recursive: true });
    await mkdir(workspaceSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses SKILL.md frontmatter and preserves SDK-relevant scalar fields", () => {
    const parsed = parseAgentRuntimeSkillMarkdown(
      [
        "---",
        "name: Research Helper",
        'description: "Line with : colon"',
        "allowed-tools: Read, Grep",
        "argument-hint: <topic>",
        "when_to_use: >",
        "  Use for research tasks.",
        "  Prefer sources.",
        "---",
        "# Instructions",
        "",
        "Use the research workflow.",
      ].join("\n"),
    );

    expect(parsed.frontMatter).toEqual({
      name: "Research Helper",
      description: "Line with : colon",
      "allowed-tools": "Read, Grep",
      "argument-hint": "<topic>",
      when_to_use: "Use for research tasks. Prefer sources.",
    });
    expect(parsed.body).toContain("Use the research workflow.");
  });

  it("marks malformed frontmatter without throwing", () => {
    const parsed = parseAgentRuntimeSkillMarkdown("---\nname: Broken\nBody without closing fence");

    expect(parsed.frontMatter).toEqual({});
    expect(parsed.body).toBe("---\nname: Broken\nBody without closing fence");
    expect(parsed.frontMatterError).toBe("missing_closing_fence");
  });

  it("skips invalid skills and continues discovering valid skills", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    await writeSkill(orgSkillsDir, "bad", "---\ndescription: [Broken]\n---\nBad body");
    await writeSkill(orgSkillsDir, "bad name", "---\ndescription: Bad name\n---\nBad name body");
    await writeSkill(orgSkillsDir, "good", "---\ndescription: Good skill\n---\nGood body");

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir, logger });

    expect(discovery.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillDir: join(orgSkillsDir, "bad"),
        reason: "invalid_frontmatter",
        scope: "org",
      }),
      "Skipping invalid agent runtime skill",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillDir: join(orgSkillsDir, "bad name"),
        reason: "invalid_name",
        scope: "org",
      }),
      "Skipping invalid agent runtime skill",
    );
  });

  it("registers a skill with a multi-paragraph folded block scalar description", async () => {
    await writeSkill(
      orgSkillsDir,
      "research",
      [
        "---",
        "description: >",
        "  First paragraph explains when to use the skill.",
        "",
        "  Second paragraph adds more routing detail.",
        "---",
        "Research body",
      ].join("\n"),
    );

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(discovery.skills).toMatchObject([
      {
        name: "research",
        description: "First paragraph explains when to use the skill.\n\nSecond paragraph adds more routing detail.",
      },
    ]);
  });

  it("registers a skill with a malformed quoted scalar as a best-effort string", async () => {
    await writeSkill(orgSkillsDir, "quoted", '---\nname: "unterminated\ndescription: Still valid\n---\nBody');

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(discovery.skills).toMatchObject([
      {
        name: "quoted",
        displayName: "unterminated",
        description: "Still valid",
        frontMatter: { name: "unterminated" },
      },
    ]);
  });

  it("discovers org-only skills", async () => {
    await writeSkill(orgSkillsDir, "research", "---\ndescription: Org research\n---\nOrg body");

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(discovery.skills).toMatchObject([{ name: "research", description: "Org research", scope: "org" }]);
    expect(discovery.collisions).toEqual([]);
  });

  it("discovers workspace-only skills", async () => {
    await writeSkill(workspaceSkillsDir, "local", "---\ndescription: Local skill\n---\nLocal body");

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(discovery.skills).toMatchObject([{ name: "local", description: "Local skill", scope: "workspace" }]);
  });

  it("keeps org-first order while workspace skills shadow org collisions", async () => {
    await writeSkill(orgSkillsDir, "alpha", "---\ndescription: Alpha org\n---\nAlpha org body");
    await writeSkill(orgSkillsDir, "shared", "---\ndescription: Shared org\n---\nShared org body");
    await writeSkill(workspaceSkillsDir, "local", "---\ndescription: Local\n---\nLocal body");
    await writeSkill(workspaceSkillsDir, "shared", "---\ndescription: Shared workspace\n---\nWorkspace body");

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(discovery.skills.map((skill) => `${skill.scope}:${skill.name}:${skill.description}`)).toEqual([
      "org:alpha:Alpha org",
      "workspace:local:Local",
      "workspace:shared:Shared workspace",
    ]);
    expect(discovery.collisions).toHaveLength(1);
    expect(discovery.collisions[0]).toMatchObject({
      name: "shared",
      chosen: { scope: "workspace", description: "Shared workspace" },
      shadowed: { scope: "org", description: "Shared org" },
      rule: "workspace_shadows_org",
    });
  });

  it("creates a Skill tool with the SDK Skill input field", async () => {
    await writeSkill(orgSkillsDir, "research", "---\ndescription: Org research\n---\nOrg body");
    const provider = new DefaultAgentRuntimeSkillsProvider();

    const tools = await provider.createSkillTool(runParams({ workspaceDir, claudeConfigDir: orgClaudeDir }));
    const skillTool = tools.Skill as unknown as {
      description: string;
      inputSchema: { shape: Record<string, unknown> };
    };

    expect(Object.keys(skillTool.inputSchema.shape)).toEqual(["skill"]);
    expect(skillTool.description).toContain("Available skills:");
    expect(skillTool.description).toContain("- research: Org research");
  });

  it("requires the declared environment before loading a managed skill", async () => {
    await writeSkill(
      orgSkillsDir,
      "github",
      "---\nprovider-type: cli:github\nrequires-env:\n  - GH_TOKEN\n---\nGitHub body",
    );
    const provider = new DefaultAgentRuntimeSkillsProvider();
    const unavailableTools = await provider.createSkillTool(runParams({ workspaceDir, claudeConfigDir: orgClaudeDir }));
    await expect(executeTool(unavailableTools, "Skill", { skill: "github" })).rejects.toThrow(
      "integration is not connected",
    );

    const availableTools = await provider.createSkillTool(
      runParams({ workspaceDir, claudeConfigDir: orgClaudeDir, agentEnv: { GH_TOKEN: "token" } }),
    );
    await expect(executeTool(availableTools, "Skill", { skill: "github" })).resolves.toContain("GitHub body");
  });

  it("normalizes GitHub skill aliases when selecting a light-runtime skill", async () => {
    await writeSkill(
      orgSkillsDir,
      "github",
      "---\nname: GitHub CLI\nprovider-type: cli:github\nrequires-env:\n  - GH_TOKEN\n---\nGitHub body",
    );
    const provider = new DefaultAgentRuntimeSkillsProvider();
    const tools = await provider.createSkillTool(
      runParams({
        workspaceDir,
        claudeConfigDir: orgClaudeDir,
        agentSkillIds: ["GitHub CLI"],
        agentEnv: { GH_TOKEN: "token" },
      }),
    );

    await expect(executeTool(tools, "Skill", { skill: "GitHub CLI" })).resolves.toContain("GitHub body");
  });

  it("returns the selected skill body and keeps the skill directory readable", async () => {
    const skillDir = await writeSkill(orgSkillsDir, "research", "---\ndescription: Org research\n---\nOrg body");
    await writeFile(join(skillDir, "reference.md"), "reference notes", "utf-8");
    const provider = new DefaultAgentRuntimeSkillsProvider();

    const tools = await provider.createSkillTool(runParams({ workspaceDir, claudeConfigDir: orgClaudeDir }));
    const result = await executeTool(tools, "Skill", { skill: "research" });

    expect(result).toBe(`Base directory for this skill: ${skillDir}\n\nOrg body`);

    const scope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspaceDir,
      orgClaudeDir,
    });
    const workspaceTools = createAgentRuntimeWorkspaceTools({ scope });
    const readResult = await executeTool(workspaceTools, "Read", { file_path: join(skillDir, "reference.md") });
    expect(readResult).toMatchObject({ type: "text", file: { content: "     1→reference notes" } });
  });

  it("discovers symlinked skill directories that resolve inside allowed roots", async () => {
    const targetDir = await writeSkill(
      join(workspaceDir, "skill-targets"),
      "linked",
      "---\ndescription: Linked skill\n---\nLinked body",
    );
    const linkedDir = join(workspaceSkillsDir, "linked");
    await symlink(targetDir, linkedDir, "dir");

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(discovery.skills).toMatchObject([{ name: "linked", description: "Linked skill", scope: "workspace" }]);
    expect(formatAgentRuntimeSkillPrompt(discovery.skills[0])).toBe(
      `Base directory for this skill: ${linkedDir}\n\nLinked body`,
    );

    const scope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspaceDir,
      orgClaudeDir,
    });
    const workspaceTools = createAgentRuntimeWorkspaceTools({ scope });
    const readResult = await executeTool(workspaceTools, "Read", { file_path: join(linkedDir, "SKILL.md") });
    expect(readResult).toMatchObject({ type: "text", file: { content: expect.stringContaining("Linked body") } });
  });

  it("skips symlinked skill directories that resolve outside allowed roots", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const targetDir = await writeSkill(
      join(root, "outside-skills"),
      "external",
      "---\ndescription: External\n---\nBody",
    );
    const linkedDir = join(workspaceSkillsDir, "external");
    await symlink(targetDir, linkedDir, "dir");

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir, logger });

    expect(discovery.skills).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        skillDir: linkedDir,
        scope: "workspace",
      }),
      "Skipping symlinked agent runtime skill outside allowed roots",
    );
  });

  it("skips skills whose SKILL.md symlink resolves outside allowed roots", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const outsideDir = join(root, "outside-files");
    await mkdir(outsideDir, { recursive: true });
    const outsideSkillFile = join(outsideDir, "SKILL.md");
    await writeFile(outsideSkillFile, "---\ndescription: Escaped\n---\nEscaped body", "utf-8");
    const escapedSkillDir = join(workspaceSkillsDir, "escaped");
    await mkdir(escapedSkillDir, { recursive: true });
    await symlink(outsideSkillFile, join(escapedSkillDir, "SKILL.md"));
    await writeSkill(workspaceSkillsDir, "valid", "---\ndescription: Valid\n---\nValid body");

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir, logger });

    expect(discovery.skills.map((skill) => skill.name)).toEqual(["valid"]);
    expect(discovery.skills.map((skill) => skill.description)).not.toContain("Escaped");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        skillDir: escapedSkillDir,
        skillFilePath: join(escapedSkillDir, "SKILL.md"),
        reason: "outside_allowed_roots",
        scope: "workspace",
      }),
      "Skipping agent runtime skill file outside allowed roots",
    );
  });

  it("loads SKILL.md symlinks that resolve inside the org Claude root", async () => {
    const sourceDir = join(orgClaudeDir, "skill-sources");
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, "linked-skill.md");
    await writeFile(sourceFile, "---\ndescription: Linked file\n---\nLinked file body", "utf-8");
    const skillDir = join(orgSkillsDir, "linked-file");
    await mkdir(skillDir, { recursive: true });
    await symlink(sourceFile, join(skillDir, "SKILL.md"));

    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(discovery.skills).toMatchObject([{ name: "linked-file", description: "Linked file", scope: "org" }]);
    expect(formatAgentRuntimeSkillPrompt(discovery.skills[0])).toBe(
      `Base directory for this skill: ${skillDir}\n\nLinked file body`,
    );
  });

  it("omits the Skill tool when the persona allowlist excludes Skill", async () => {
    await writeSkill(orgSkillsDir, "research", "---\ndescription: Org research\n---\nOrg body");
    const provider = new DefaultAgentRuntimeSkillsProvider();

    const tools = await provider.createSkillTool(
      runParams({ workspaceDir, claudeConfigDir: orgClaudeDir, agentAllowedTools: ["Read"] }),
    );

    expect(tools).toEqual({});
  });

  it("loads workspace-only CLAUDE.md memory", async () => {
    await writeFile(join(workspaceDir, "CLAUDE.md"), "workspace memory", "utf-8");

    const loaded = await loadAgentRuntimeClaudeMdContext({ workspaceDir, order: ["org", "workspace"] });

    expect(loaded.sources).toMatchObject([{ scope: "workspace", exists: true, content: "workspace memory" }]);
    expect(loaded.appendedSystemContext).toContain("### Workspace CLAUDE.md");
    expect(loaded.appendedSystemContext).toContain("workspace memory");
  });

  it("skips workspace CLAUDE.md symlinks that resolve outside the workspace", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const outsideDir = join(root, "outside-memory");
    await mkdir(outsideDir, { recursive: true });
    const outsideClaudeMd = join(outsideDir, "CLAUDE.md");
    await writeFile(outsideClaudeMd, "outside memory", "utf-8");
    await symlink(outsideClaudeMd, join(workspaceDir, "CLAUDE.md"));

    const loaded = await loadAgentRuntimeClaudeMdContext({ workspaceDir, order: ["org", "workspace"], logger });

    expect(loaded.sources).toMatchObject([{ scope: "workspace", exists: false, content: null }]);
    expect(loaded.appendedSystemContext).not.toContain("outside memory");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "workspace",
        path: join(workspaceDir, "CLAUDE.md"),
        reason: "outside_allowed_roots",
      }),
      "Skipping agent runtime CLAUDE.md outside allowed root",
    );
  });

  it("loads workspace CLAUDE.md symlinks that resolve inside the workspace", async () => {
    const memoryDir = join(workspaceDir, "memory");
    await mkdir(memoryDir, { recursive: true });
    const memoryFile = join(memoryDir, "workspace.md");
    await writeFile(memoryFile, "workspace symlink memory", "utf-8");
    await symlink(memoryFile, join(workspaceDir, "CLAUDE.md"));

    const loaded = await loadAgentRuntimeClaudeMdContext({ workspaceDir, order: ["org", "workspace"] });

    expect(loaded.sources).toMatchObject([{ scope: "workspace", exists: true, content: "workspace symlink memory" }]);
    expect(loaded.appendedSystemContext).toContain("workspace symlink memory");
  });

  it("skips org CLAUDE.md symlinks that resolve outside the org Claude root", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const workspaceMemory = join(workspaceDir, "org-escape.md");
    await writeFile(workspaceMemory, "workspace private memory", "utf-8");
    await symlink(workspaceMemory, join(orgClaudeDir, "CLAUDE.md"));

    const loaded = await loadAgentRuntimeClaudeMdContext({
      orgClaudeDir,
      workspaceDir,
      order: ["org", "workspace"],
      logger,
    });

    expect(loaded.sources).toMatchObject([
      { scope: "org", exists: false, content: null },
      { scope: "workspace", exists: false, content: null },
    ]);
    expect(loaded.appendedSystemContext).not.toContain("workspace private memory");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "org",
        path: join(orgClaudeDir, "CLAUDE.md"),
        reason: "outside_allowed_roots",
      }),
      "Skipping agent runtime CLAUDE.md outside allowed root",
    );
  });

  it("loads org-only CLAUDE.md memory", async () => {
    await writeFile(join(orgClaudeDir, "CLAUDE.md"), "org memory", "utf-8");

    const loaded = await loadAgentRuntimeClaudeMdContext({ orgClaudeDir, workspaceDir, order: ["org", "workspace"] });

    expect(loaded.sources).toMatchObject([
      { scope: "org", exists: true, content: "org memory" },
      { scope: "workspace", exists: false, content: null },
    ]);
    expect(loaded.appendedSystemContext).toContain("### Org CLAUDE.md");
    expect(loaded.appendedSystemContext).toContain("org memory");
  });

  it("loads org memory before workspace memory and prepends it to the system context", async () => {
    await writeFile(join(orgClaudeDir, "CLAUDE.md"), "org memory", "utf-8");
    await writeFile(join(workspaceDir, "CLAUDE.md"), "workspace memory", "utf-8");

    const loaded = await loadAgentRuntimeClaudeMdContext({ orgClaudeDir, workspaceDir, order: ["org", "workspace"] });
    const systemContext = prependClaudeMdContext({
      claudeMdContext: loaded.appendedSystemContext,
      systemContext: "Sketch system context",
    });

    expect(loaded.sources.map((source) => source.scope)).toEqual(["org", "workspace"]);
    expect(systemContext.indexOf("org memory")).toBeLessThan(systemContext.indexOf("workspace memory"));
    expect(systemContext.indexOf("workspace memory")).toBeLessThan(systemContext.indexOf("Sketch system context"));
  });

  it("loads a shared org/workspace CLAUDE.md only once", async () => {
    await writeFile(join(workspaceDir, "CLAUDE.md"), "shared memory", "utf-8");

    const loaded = await loadAgentRuntimeClaudeMdContext({
      orgClaudeDir: workspaceDir,
      workspaceDir,
      order: ["org", "workspace"],
    });

    expect(loaded.sources).toMatchObject([{ scope: "org", exists: true, content: "shared memory" }]);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.appendedSystemContext.match(/shared memory/g)).toHaveLength(1);
  });

  it("returns empty CLAUDE.md context when files are missing", async () => {
    const loaded = await loadAgentRuntimeClaudeMdContext({ orgClaudeDir, workspaceDir, order: ["org", "workspace"] });

    expect(loaded.sources).toMatchObject([
      { scope: "org", exists: false, content: null },
      { scope: "workspace", exists: false, content: null },
    ]);
    expect(loaded.appendedSystemContext).toBe("");
    expect(prependClaudeMdContext({ claudeMdContext: "", systemContext: "base" })).toBe("base");
  });

  it("formats the skill prompt with the base directory used for companion files", async () => {
    await writeSkill(workspaceSkillsDir, "local", "---\ndescription: Local\n---\nLocal body");
    const discovery = await discoverAgentRuntimeSkills({ orgClaudeDir, workspaceDir });

    expect(formatAgentRuntimeSkillPrompt(discovery.skills[0])).toBe(
      `Base directory for this skill: ${join(workspaceSkillsDir, "local")}\n\nLocal body`,
    );
    await expect(readFile(join(workspaceSkillsDir, "local", "SKILL.md"), "utf-8")).resolves.toContain("Local body");
  });
});
