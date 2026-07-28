import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { SketchMcpDeps, ToolResult } from "./types";

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function handleSetUserTimezone(
  params: { timezone: string },
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.userRepo || !deps.userRepo.update || !deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Timezone update is not available in this context." }] };
  }
  const tz = params.timezone.trim();
  if (!tz) {
    return { content: [{ type: "text" as const, text: "Error: timezone is required." }] };
  }
  if (!isValidTimezone(tz)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: '${tz}' is not a valid IANA timezone. Examples: 'Asia/Kolkata', 'America/New_York', 'Europe/London'.`,
        },
      ],
    };
  }
  await deps.userRepo.update(deps.currentUserId, { timezone: tz });
  return { content: [{ type: "text" as const, text: `Timezone set to ${tz}.` }] };
}

export async function handleGetTeamDirectory(
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.userRepo) return { content: [{ type: "text" as const, text: "Team directory not available." }] };
  const users = await deps.userRepo.list();
  const directory = users.map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role ?? null,
    workspaceRole: u.auth_role,
    isCurrentUser: u.id === deps.currentUserId,
    type: u.type,
    description: u.description ?? "No description",
    channels: [...(u.slack_user_id ? ["slack"] : []), ...(u.whatsapp_number ? ["whatsapp"] : [])],
  }));
  return { content: [{ type: "text" as const, text: JSON.stringify(directory, null, 2) }] };
}

export function createTeamTools(deps: SketchMcpDeps) {
  return [
    tool(
      "GetTeamDirectory",
      "Discover team members and their roles, including yourself. `role` is the org or job role, `workspaceRole` is workspace access (`admin` or `member`), and `isCurrentUser` identifies the caller.",
      {},
      async () => handleGetTeamDirectory(deps),
    ),

    tool(
      "SetUserTimezone",
      "Update the current user's timezone. Use IANA names (e.g. 'Asia/Kolkata', 'America/New_York', 'Europe/London'). Call this when the user explicitly asks to change their timezone — the system already auto-resolves a default from Slack profile / WhatsApp country code.",
      {
        timezone: z.string().describe("IANA timezone name, e.g. 'Asia/Kolkata' or 'America/New_York'."),
      },
      async (params) => handleSetUserTimezone(params, deps),
    ),
  ];
}
