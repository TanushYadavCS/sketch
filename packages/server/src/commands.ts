export type SketchCommand = "new_session";
export const NEW_SESSION_CONFIRMATION = "Started a new session.";

export function parseSketchCommand(text: string | null | undefined): SketchCommand | null {
  const normalized = text?.trim();
  if (!normalized) return null;
  if (/^\/new(?:\s|$)/.test(normalized)) return "new_session";
  return null;
}
