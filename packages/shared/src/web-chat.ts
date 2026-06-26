export const WEB_CHAT_PROGRESS_RENDERER_MODES = ["off", "friendly", "technical"] as const;

export type WebChatProgressRendererMode = (typeof WEB_CHAT_PROGRESS_RENDERER_MODES)[number];

export interface WebChatProgressSettings {
  toolProgress: WebChatProgressRendererMode;
}

export type WebProgressItemKind =
  | "reasoning"
  | "file"
  | "search"
  | "shell"
  | "web"
  | "canvas"
  | "skill"
  | "integration"
  | "attachment"
  | "audio"
  | "image"
  | "schedule"
  | "entity"
  | "chat"
  | "delivery"
  | "local"
  | "tool";

export type WebProgressIconType = "tool" | "skill" | "canvas" | "generic";

export interface WebProgressIcon {
  type: WebProgressIconType;
  name?: string;
}

export interface WebProgressItem {
  kind: WebProgressItemKind;
  label: string;
  icon: WebProgressIcon;
  detail?: string;
  toolName?: string;
}

export interface WebChatProgressData {
  lines: string[];
  items?: WebProgressItem[];
}

export interface WebChatIntegrationConnectionData {
  requestId: string;
  appId: string;
  appName: string;
  state?: "connect" | "connected";
  icon?: string;
  reason?: string;
  connectUrl?: string;
  accountName?: string;
  connectionId?: string | null;
}
