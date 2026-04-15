export type SketchCommand = "new_session";
export const NEW_SESSION_CONFIRMATIONS = [
  "Started a new session. ✨",
  "Session reset. Ready for a fresh start. 🌱",
  "Fresh session ready. 🚀",
  "Context cleared. Starting fresh. 🧹",
  "New conversation started. 💬",
] as const;

export function parseSketchCommand(text: string | null | undefined): SketchCommand | null {
  const normalized = text?.trim();
  if (!normalized) return null;
  if (/^\/new(?:\s|$)/.test(normalized)) return "new_session";
  return null;
}

export function getNewSessionConfirmation(randomValue = Math.random()): string {
  const index = Math.floor(randomValue * NEW_SESSION_CONFIRMATIONS.length);
  return NEW_SESSION_CONFIRMATIONS[index] ?? NEW_SESSION_CONFIRMATIONS[0];
}
