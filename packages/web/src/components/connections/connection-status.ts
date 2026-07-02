import type { IntegrationConnection } from "@sketch/shared";

export function isNativeCanvasAppConnection(connection: IntegrationConnection): boolean {
  return connection.source === "canvas_user_secrets";
}

export function isOwnedOrPersonalAppConnection(connection: IntegrationConnection): boolean {
  return (
    connection.source !== "canvas_user_secrets" ||
    connection.accessLevel !== "organization" ||
    connection.isOwnedByViewer !== false
  );
}
