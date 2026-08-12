import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";

export const MANAGED_GITHUB_SKILL = `---
name: GitHub CLI
description: Use GitHub through the managed gh CLI for repository, issue, pull request, workflow, and release work.
category: engineering
provider-type: cli:github
requires-env:
  - GH_TOKEN
---

# GitHub CLI

Use the GitHub CLI executable \`gh\` for GitHub work. The Sketch runtime supplies authentication only when the current user or conversation is authorized to use GitHub.

## Safe workflow

1. Start with discovery. Use \`gh repo list\`, \`gh repo view OWNER/REPO\`, or a read-only command to identify the repository before reading or changing it.
2. Prefer JSON output and \`--jq\` for stable, concise results. Use \`--paginate\` when the result can span pages.
3. Pass \`--repo OWNER/REPO\` explicitly whenever the working directory does not make the target unambiguous.
4. Read before writing. For issues, pull requests, workflows, and releases, show the proposed target and change, then ask for normal user confirmation before a write.
5. Use \`gh api\` only when a dedicated command does not expose the needed endpoint. Keep API paths explicit and never put tokens in arguments.

Useful read commands include \`gh repo view --repo OWNER/REPO --json nameWithOwner,defaultBranchRef\`, \`gh issue list --repo OWNER/REPO --json number,title,state --limit 20\`, \`gh pr list --repo OWNER/REPO --json number,title,state --limit 20\`, \`gh run list --repo OWNER/REPO --json databaseId,status,conclusion --limit 20\`, and \`gh release list --repo OWNER/REPO --limit 20\`.

Use \`gh issue create\`, \`gh pr create\`, \`gh workflow run\`, and \`gh release create\` only after the user has confirmed the intended write. Explain provider errors plainly and retry only when the error is transient.

Never use \`$CANVAS_CLI\`, Canvas MCP tools, raw HTTP authorization headers, raw tokens, token-printing commands, or commands that expose the process environment. Do not pass a token in a URL, shell argument, file, issue, pull request, or log. Keep generated files inside the Sketch workspace.
`;

export async function ensureBuiltinManagedSkills(config: Pick<Config, "CLAUDE_CONFIG_DIR">): Promise<void> {
  const skillPath = join(config.CLAUDE_CONFIG_DIR, "skills", "github", "SKILL.md");
  let existing: string | null = null;
  try {
    existing = await readFile(skillPath, "utf8");
  } catch {}
  if (existing?.includes("provider-type: cli:github") && existing.includes("requires-env:")) return;
  await mkdir(join(config.CLAUDE_CONFIG_DIR, "skills", "github"), { recursive: true });
  await writeFile(skillPath, MANAGED_GITHUB_SKILL, "utf8");
}
