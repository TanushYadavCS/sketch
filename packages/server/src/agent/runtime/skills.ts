import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type Tool, type ToolSet, tool } from "ai";
import { z } from "zod/v4";
import type { Logger } from "../../logger";
import type { RunAgentParams } from "../runner";
import type {
  AgentRuntimeClaudeMdLoaderInput,
  AgentRuntimeClaudeMdLoaderOutput,
  AgentRuntimeClaudeMemorySource,
  AgentRuntimeSkillDescriptor,
  AgentRuntimeSkillDiscoveryResult,
  AgentRuntimeSkillScope,
  AgentRuntimeSkillsProvider,
} from "./contracts";

const SKILL_FILE_NAMES = ["SKILL.md", "SKILL.MD"] as const;
const SKILL_TOOL_NAME = "Skill";
const SKILL_DESCRIPTION_LIMIT = 1536;

type ToolToModelOutput = NonNullable<Tool["toModelOutput"]>;

export interface AgentRuntimeParsedSkillMarkdown {
  frontMatter: Readonly<Record<string, string>>;
  body: string;
  frontMatterError?: string;
}

type ParsedFrontMatterScalar =
  | { behavior: "valid"; value: string }
  | { behavior: "invalid"; reason: "invalid_quoted_scalar" | "unsupported_scalar" };

type ParsedFrontMatterBlock =
  | { behavior: "valid"; frontMatter: Record<string, string> }
  | { behavior: "invalid"; reason: string };

type AgentRuntimeSkillLogger = Pick<Logger, "debug" | "warn">;
type AgentRuntimeFileContainmentResolution =
  | { behavior: "allow"; realpath: string }
  | { behavior: "missing" }
  | { behavior: "deny"; reason: "outside_allowed_roots" | "unresolved"; targetRealpath: string | null };

function parseFrontMatterScalar(value: string): ParsedFrontMatterScalar {
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return { behavior: "valid", value: parsed };
    } catch {
      return { behavior: "valid", value: value.replace(/^"/, "").replace(/"$/, "") };
    }

    return { behavior: "invalid", reason: "unsupported_scalar" };
  }

  if (value.startsWith("'")) {
    if (value.length >= 2 && value.endsWith("'")) return { behavior: "valid", value: value.slice(1, -1) };
    return { behavior: "valid", value: value.replace(/^'/, "").replace(/'$/, "") };
  }

  if (value.startsWith("[") || value.startsWith("{")) return { behavior: "invalid", reason: "unsupported_scalar" };

  return { behavior: "valid", value };
}

function parseFrontMatterBlock(raw: string): ParsedFrontMatterBlock {
  const frontMatter: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !line.trim()) continue;
    if (/^\s/.test(line)) return { behavior: "invalid", reason: "unexpected_indented_line" };

    const separator = line.indexOf(":");
    if (separator === -1) return { behavior: "invalid", reason: "missing_key_value_separator" };

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return { behavior: "invalid", reason: "invalid_key" };

    const parsed = parseFrontMatterScalar(line.slice(separator + 1).trim());
    if (parsed.behavior === "invalid") return { behavior: "invalid", reason: parsed.reason };

    let value = parsed.value;
    if (value === ">" || value === "|") {
      const folded = value === ">";
      const parts: string[] = [];
      let blockIndent: number | null = null;
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1] ?? "";
        if (!nextLine.trim()) {
          index += 1;
          parts.push("");
          continue;
        }

        const indent = nextLine.match(/^\s*/)?.[0].length ?? 0;
        if (indent === 0) break;
        blockIndent ??= indent;
        if (indent < blockIndent) break;
        index += 1;
        parts.push((lines[index] ?? "").slice(blockIndent).trimEnd());
      }
      value = folded
        ? parts
            .join("\n")
            .split(/\n{2,}/)
            .map((paragraph) =>
              paragraph
                .split(/\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .join(" "),
            )
            .filter(Boolean)
            .join("\n\n")
        : parts.join("\n");
    }

    frontMatter[key] = value;
  }

  return { behavior: "valid", frontMatter };
}

export function parseAgentRuntimeSkillMarkdown(markdown: string): AgentRuntimeParsedSkillMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { frontMatter: {}, body: normalized.trim() };

  const frontMatterEnd = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized.slice(3));
  if (!frontMatterEnd) {
    return { frontMatter: {}, body: normalized.trim(), frontMatterError: "missing_closing_fence" };
  }

  const end = 3 + frontMatterEnd.index;
  const raw = normalized.slice(3, end).trim();
  const body = normalized.slice(end + frontMatterEnd[0].length).trim();
  const parsed = parseFrontMatterBlock(raw);
  if (parsed.behavior === "invalid") {
    return { frontMatter: {}, body, frontMatterError: parsed.reason };
  }

  return { frontMatter: parsed.frontMatter, body };
}

function inferDescription(body: string): string {
  const line = body
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !value.startsWith("#"));
  return line ?? "";
}

async function readSkillMarkdown(params: {
  skillDir: string;
  scope: AgentRuntimeSkillScope;
  allowedRoots: readonly string[];
  logger?: AgentRuntimeSkillLogger;
}): Promise<{ path: string; markdown: string } | null> {
  for (const fileName of SKILL_FILE_NAMES) {
    const skillFilePath = join(params.skillDir, fileName);
    const containedFile = await resolveFileWithinAllowedRoots(skillFilePath, params.allowedRoots);
    if (containedFile.behavior === "missing") continue;
    if (containedFile.behavior === "deny") {
      params.logger?.debug(
        {
          skillDir: params.skillDir,
          skillFilePath,
          targetRealpath: containedFile.targetRealpath,
          reason: containedFile.reason,
          scope: params.scope,
        },
        "Skipping agent runtime skill file outside allowed roots",
      );
      return null;
    }

    try {
      return { path: skillFilePath, markdown: await readFile(containedFile.realpath, "utf-8") };
    } catch {}
  }

  return null;
}

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isUsableSkillName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function resolveFileWithinAllowedRoots(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<AgentRuntimeFileContainmentResolution> {
  try {
    await lstat(filePath);
  } catch {
    return { behavior: "missing" };
  }

  const fileRealpath = await realpathIfExists(filePath);
  if (!fileRealpath) return { behavior: "deny", reason: "unresolved", targetRealpath: null };
  if (!isAllowedSkillRealpath(fileRealpath, allowedRoots)) {
    return { behavior: "deny", reason: "outside_allowed_roots", targetRealpath: fileRealpath };
  }

  return { behavior: "allow", realpath: fileRealpath };
}

async function resolveSkillAllowedRoots(params: {
  workspaceDir: string;
  orgClaudeDir?: string | null;
}): Promise<string[]> {
  const roots = [params.workspaceDir, params.orgClaudeDir].filter((root): root is string => !!root);
  const seen = new Set<string>();
  const realpaths: string[] = [];

  for (const root of roots) {
    const resolved = await realpathIfExists(resolve(root));
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    realpaths.push(resolved);
  }

  return realpaths;
}

function isAllowedSkillRealpath(path: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((root) => isInsideDir(path, root));
}

async function loadSkillsFromDir(params: {
  skillsDir: string;
  scope: AgentRuntimeSkillScope;
  allowedRoots: readonly string[];
  logger?: AgentRuntimeSkillLogger;
}): Promise<AgentRuntimeSkillDescriptor[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = await readdir(params.skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: AgentRuntimeSkillDescriptor[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const dir = join(params.skillsDir, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const dirStat = await stat(dir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const dirRealpath = await realpathIfExists(dir);
    if (!dirRealpath) continue;

    if (entry.isSymbolicLink() && !isAllowedSkillRealpath(dirRealpath, params.allowedRoots)) {
      params.logger?.debug(
        { skillDir: dir, targetRealpath: dirRealpath, scope: params.scope },
        "Skipping symlinked agent runtime skill outside allowed roots",
      );
      continue;
    }

    const skillMarkdown = await readSkillMarkdown({
      skillDir: dir,
      scope: params.scope,
      allowedRoots: params.allowedRoots,
      logger: params.logger,
    });
    if (!skillMarkdown) continue;

    const { frontMatter, body, frontMatterError } = parseAgentRuntimeSkillMarkdown(skillMarkdown.markdown);
    const displayName = frontMatter.name?.trim();
    if (!isUsableSkillName(entry.name) || frontMatterError || (Object.hasOwn(frontMatter, "name") && !displayName)) {
      params.logger?.warn(
        {
          skillDir: dir,
          scope: params.scope,
          reason: frontMatterError ? "invalid_frontmatter" : "invalid_name",
        },
        "Skipping invalid agent runtime skill",
      );
      continue;
    }

    const description = frontMatter.description ?? inferDescription(body);

    skills.push({
      id: entry.name,
      name: entry.name,
      ...(displayName ? { displayName } : {}),
      description,
      dir,
      skillFilePath: skillMarkdown.path,
      scope: params.scope,
      frontMatter,
      body,
    });
  }

  return skills;
}

export async function discoverAgentRuntimeSkills(params: {
  orgClaudeDir?: string | null;
  workspaceDir: string;
  logger?: AgentRuntimeSkillLogger;
}): Promise<AgentRuntimeSkillDiscoveryResult> {
  const orgSkillsDir = params.orgClaudeDir ? join(params.orgClaudeDir, "skills") : null;
  const workspaceSkillsDir = join(params.workspaceDir, ".claude", "skills");
  const allowedRoots = await resolveSkillAllowedRoots(params);
  const orgSkills = orgSkillsDir
    ? await loadSkillsFromDir({ skillsDir: orgSkillsDir, scope: "org", allowedRoots, logger: params.logger })
    : [];
  const workspaceSkills = await loadSkillsFromDir({
    skillsDir: workspaceSkillsDir,
    scope: "workspace",
    allowedRoots,
    logger: params.logger,
  });
  const byName = new Map<string, AgentRuntimeSkillDescriptor>();
  const collisions: Array<AgentRuntimeSkillDiscoveryResult["collisions"][number]> = [];

  for (const skill of orgSkills) {
    byName.set(skill.name, skill);
  }

  for (const skill of workspaceSkills) {
    const shadowed = byName.get(skill.name);
    if (shadowed?.scope === "org") {
      byName.delete(skill.name);
      collisions.push({
        name: skill.name,
        chosen: skill as AgentRuntimeSkillDescriptor & { scope: "workspace" },
        shadowed: shadowed as AgentRuntimeSkillDescriptor & { scope: "org" },
        rule: "workspace_shadows_org",
      });
    }
    byName.set(skill.name, skill);
  }

  return {
    orgSkillsDir,
    workspaceSkillsDir,
    order: ["org", "workspace"],
    collisionRule: "workspace_shadows_org",
    skills: Array.from(byName.values()),
    collisions,
  };
}

function agentAllowsSkill(agentAllowedTools: string[] | null | undefined): boolean {
  return agentAllowedTools == null || agentAllowedTools.includes(SKILL_TOOL_NAME);
}

function truncateDescription(description: string): string {
  if (description.length <= SKILL_DESCRIPTION_LIMIT) return description;
  return `${description.slice(0, SKILL_DESCRIPTION_LIMIT - 3)}...`;
}

export function formatAgentRuntimeSkillToolDescription(
  skills: readonly Pick<AgentRuntimeSkillDescriptor, "name" | "description">[],
): string {
  const listing = skills.map((skill) => `- ${skill.name}: ${truncateDescription(skill.description)}`).join("\n");
  return ["Load a skill's instructions into the conversation before using it.", "", "Available skills:", listing].join(
    "\n",
  );
}

export function formatAgentRuntimeSkillPrompt(skill: AgentRuntimeSkillDescriptor): string {
  return `Base directory for this skill: ${skill.dir}\n\n${skill.body}`;
}

function skillToModelOutput({ output }: Parameters<ToolToModelOutput>[0]): ReturnType<ToolToModelOutput> {
  return { type: "content", value: [{ type: "text", text: String(output) }] };
}

export class DefaultAgentRuntimeSkillsProvider implements AgentRuntimeSkillsProvider {
  async createSkillTool(params: RunAgentParams): Promise<ToolSet> {
    if (!agentAllowsSkill(params.agentAllowedTools)) return {};

    const discovery = await discoverAgentRuntimeSkills({
      orgClaudeDir: params.claudeConfigDir,
      workspaceDir: params.workspaceDir,
      logger: params.logger,
    });
    if (discovery.skills.length === 0) return {};

    const byName = new Map(discovery.skills.map((skill) => [skill.name, skill]));

    return {
      [SKILL_TOOL_NAME]: tool({
        description: formatAgentRuntimeSkillToolDescription(discovery.skills),
        inputSchema: z.object({
          skill: z.string(),
        }),
        execute: async ({ skill }: { skill: string }) => {
          const selected = byName.get(skill);
          if (!selected) throw new Error(`Skill not found: ${skill}`);
          return formatAgentRuntimeSkillPrompt(selected);
        },
        toModelOutput: skillToModelOutput,
      }),
    };
  }
}

export function createDefaultAgentRuntimeSkillsProvider(): AgentRuntimeSkillsProvider {
  return new DefaultAgentRuntimeSkillsProvider();
}

async function loadClaudeMemorySource(
  scope: "org" | "workspace",
  path: string,
  readPath: string | null,
): Promise<AgentRuntimeClaudeMemorySource> {
  if (!readPath) return { scope, path, exists: false, content: null };

  try {
    return { scope, path, exists: true, content: await readFile(readPath, "utf-8") };
  } catch {
    return { scope, path, exists: false, content: null };
  }
}

async function resolveClaudeMemoryCandidate(params: {
  scope: "org" | "workspace";
  path: string;
  rootPath: string;
  logger?: AgentRuntimeSkillLogger;
}): Promise<{ scope: "org" | "workspace"; path: string; key: string; readPath: string | null }> {
  const rootRealpath = await realpathIfExists(resolve(params.rootPath));
  if (!rootRealpath) return { scope: params.scope, path: params.path, key: resolve(params.path), readPath: null };

  const containedFile = await resolveFileWithinAllowedRoots(params.path, [rootRealpath]);
  if (containedFile.behavior === "missing") {
    return { scope: params.scope, path: params.path, key: resolve(params.path), readPath: null };
  }

  if (containedFile.behavior === "deny") {
    params.logger?.debug(
      {
        scope: params.scope,
        path: params.path,
        targetRealpath: containedFile.targetRealpath,
        reason: containedFile.reason,
      },
      "Skipping agent runtime CLAUDE.md outside allowed root",
    );
    return {
      scope: params.scope,
      path: params.path,
      key: containedFile.targetRealpath ?? resolve(params.path),
      readPath: null,
    };
  }

  return { scope: params.scope, path: params.path, key: containedFile.realpath, readPath: containedFile.realpath };
}

async function loadDistinctClaudeMemorySources(
  input: AgentRuntimeClaudeMdLoaderInput & { logger?: AgentRuntimeSkillLogger },
): Promise<AgentRuntimeClaudeMemorySource[]> {
  const candidates = [
    ...(input.orgClaudeDir
      ? [{ scope: "org" as const, path: join(input.orgClaudeDir, "CLAUDE.md"), rootPath: input.orgClaudeDir }]
      : []),
    { scope: "workspace" as const, path: join(input.workspaceDir, "CLAUDE.md"), rootPath: input.workspaceDir },
  ];
  const seen = new Set<string>();
  const sources: AgentRuntimeClaudeMemorySource[] = [];

  for (const candidate of candidates) {
    const resolved = await resolveClaudeMemoryCandidate({ ...candidate, logger: input.logger });
    if (seen.has(resolved.key)) continue;
    seen.add(resolved.key);
    sources.push(await loadClaudeMemorySource(resolved.scope, resolved.path, resolved.readPath));
  }

  return sources;
}

function formatClaudeMemoryContext(sources: readonly AgentRuntimeClaudeMemorySource[]): string {
  const loaded = sources.filter((source) => source.exists && source.content?.trim());
  if (loaded.length === 0) return "";

  const sections = loaded.flatMap((source) => [
    `### ${source.scope === "org" ? "Org" : "Workspace"} CLAUDE.md`,
    "",
    source.content?.trim() ?? "",
  ]);

  return ["## Loaded CLAUDE.md Memory", "", ...sections].join("\n");
}

export async function loadAgentRuntimeClaudeMdContext(
  input: AgentRuntimeClaudeMdLoaderInput & { logger?: AgentRuntimeSkillLogger },
): Promise<AgentRuntimeClaudeMdLoaderOutput> {
  const sources = await loadDistinctClaudeMemorySources(input);

  return {
    order: input.order,
    sources,
    appendedSystemContext: formatClaudeMemoryContext(sources),
  };
}

export function prependClaudeMdContext(params: { claudeMdContext: string; systemContext: string }): string {
  if (!params.claudeMdContext.trim()) return params.systemContext;
  return `${params.claudeMdContext}\n\n${params.systemContext}`;
}
