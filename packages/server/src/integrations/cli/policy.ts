import { isCanvasBlockedCliAppId, isCanvasBlockedCliComponentKey, managedCliIntegrationAppId } from "@sketch/shared";

export function isCanvasBlockedAppId(value: string): boolean {
  return isCanvasBlockedCliAppId(value);
}

export function isCanvasBlockedComponentKey(value: string): boolean {
  return isCanvasBlockedCliComponentKey(value);
}

export { managedCliIntegrationAppId };

export function isCanvasBlockedConnectionId(value: string): boolean {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .some((segment) => isCanvasBlockedAppId(segment));
}

export function canvasBlockedIntegrationMessage(): string {
  return "GitHub and Linear are managed by Sketch integrations. Connect them from Integrations instead of Canvas.";
}
