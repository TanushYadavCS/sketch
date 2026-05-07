import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";

export async function ensureWorkspace(config: Config, userId: string): Promise<string> {
  const workspaceDir = join(config.DATA_DIR, "workspaces", userId);
  await mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

export async function ensureChannelWorkspace(config: Config, slackChannelId: string): Promise<string> {
  const workspaceDir = join(config.DATA_DIR, "workspaces", `channel-${slackChannelId}`);
  await mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

export async function ensureGroupWorkspace(config: Config, groupJid: string): Promise<string> {
  const groupId = groupJid.replace("@g.us", "");
  const workspaceDir = join(config.DATA_DIR, "workspaces", `wa-group-${groupId}`);
  await mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

/**
 * Per-agent sub-workspace at data/workspaces/agent-{agentId}/{subKey}/.
 * Used when a /team agent is bound to a Slack channel, WhatsApp group, or
 * external WhatsApp DM sender — so different runs under the same agent share
 * a parent directory while staying isolated by sub-key.
 */
export async function ensureAgentSubWorkspace(config: Config, agentId: string, subKey: string): Promise<string> {
  const workspaceDir = join(config.DATA_DIR, "workspaces", `agent-${agentId}`, subKey);
  await mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}
