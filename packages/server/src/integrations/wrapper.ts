/**
 * Ephemeral credential wrapper for integration CLIs.
 *
 * Generates a per-agent-run shell script that embeds credentials and delegates
 * to the real CLI. The agent only sees an env var pointing to the wrapper path
 * (e.g. $CANVAS_CLI) — never the API key or user email.
 *
 * The wrapper is deleted after the agent run completes.
 */
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";

interface SkillModeProvider {
  type: string;
  credentials: string;
}

export interface WrapperResult {
  envVars: Record<string, string>;
  wrapperPaths: string[];
}

/**
 * Resolve integration wrappers for all skill-mode providers.
 * Returns env vars to set on the agent subprocess (just paths, no credentials)
 * and wrapper file paths for cleanup.
 */
export async function resolveIntegrationWrappers(params: {
  runId: string;
  userEmail: string | null;
  claudeConfigDir: string;
  findIntegrationProvider: () => Promise<SkillModeProvider | null>;
  logger: Logger;
}): Promise<WrapperResult> {
  const { runId, userEmail, logger, claudeConfigDir } = params;
  const envVars: Record<string, string> = {};
  const wrapperPaths: string[] = [];

  const provider = await params.findIntegrationProvider();
  if (!provider) return { envVars, wrapperPaths };

  if (provider.type === "canvas") {
    const creds = JSON.parse(provider.credentials) as Record<string, string>;
    const cliPath = join(claudeConfigDir, "skills", "canvas", "canvas-cli.js");

    const wrapperEnv: Record<string, string> = {};
    if (creds.apiKey) wrapperEnv.CANVAS_API_KEY_MCP = creds.apiKey;
    if (userEmail) wrapperEnv.CANVAS_USER_EMAIL = userEmail;

    const wrapperPath = generateWrapper({ runId, slug: "canvas", cliPath, envVars: wrapperEnv });
    wrapperPaths.push(wrapperPath);
    envVars.CANVAS_CLI = wrapperPath;

    // Do NOT expose CANVAS_API_KEY_MCP or CANVAS_USER_EMAIL to the agent subprocess.
    // The Canvas CLI embeds an MCP server manifest — if the SDK finds these env vars,
    // it auto-registers Canvas as an MCP server (exposing the API key to the agent).
    // By keeping them only inside the wrapper script, the SDK's MCP registration fails
    // silently and the agent uses Canvas via $CANVAS_CLI (Bash) only.

    logger.debug({ wrapperPath }, "Integration wrapper: created for canvas");
  }

  return { envVars, wrapperPaths };
}

function generateWrapper(config: {
  runId: string;
  slug: string;
  cliPath: string;
  envVars: Record<string, string>;
}): string {
  const wrapperPath = join("/tmp", `sketch-int-${config.slug}-${config.runId}.sh`);
  const envLines = Object.entries(config.envVars)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}" \\`)
    .join("\n");

  const content = `#!/bin/bash
${envLines}
exec node "${config.cliPath}" "$@"
`;

  writeFileSync(wrapperPath, content);
  chmodSync(wrapperPath, 0o700);
  return wrapperPath;
}

/**
 * Clean up ephemeral wrapper files after an agent run completes.
 * The env vars are scoped to the SDK subprocess via options.env — nothing
 * to clean up in the parent process.
 */
export function cleanupWrappers(result: WrapperResult): void {
  for (const wrapperPath of result.wrapperPaths) {
    try {
      unlinkSync(wrapperPath);
    } catch {}
  }
}
