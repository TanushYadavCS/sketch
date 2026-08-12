import { isCanvasBlockedCliAppId, isCanvasBlockedCliComponentKey } from "@sketch/shared";

export function isCanvasBlockedAppId(value: string): boolean {
  return isCanvasBlockedCliAppId(value);
}

export function isCanvasBlockedComponentKey(value: string): boolean {
  return isCanvasBlockedCliComponentKey(value);
}

export function isCanvasBlockedConnectionId(value: string): boolean {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .some((segment) => isCanvasBlockedAppId(segment));
}

export function canvasBlockedIntegrationMessage(): string {
  return "GitHub is managed by Sketch's GitHub integration. Connect it from Integrations instead of Canvas.";
}
