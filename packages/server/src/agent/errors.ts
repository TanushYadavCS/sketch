export const PROMPT_TOO_LONG_RECOVERY_MESSAGE =
  "This conversation has gotten too large for me to continue.\n\nSend /new to start a fresh session, then send your request again.";

export const PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE =
  "This conversation has gotten too large for me to continue.\n\nMention me with /new to start a fresh session, then send your request again.";

export function isPromptTooLongError(err: unknown): boolean {
  return collectErrorMessages(err).some((message) => /prompt is too long/i.test(message));
}

export function agentFailureMessage(
  err: unknown,
  fallback: string,
  recoveryMessage = PROMPT_TOO_LONG_RECOVERY_MESSAGE,
): string {
  return isPromptTooLongError(err) ? recoveryMessage : fallback;
}

function collectErrorMessages(err: unknown, seen = new Set<unknown>()): string[] {
  if (err == null || seen.has(err)) return [];
  seen.add(err);

  if (typeof err === "string") return [err];
  if (!(err instanceof Error)) {
    if (typeof err === "object" && "message" in err && typeof err.message === "string") {
      return [err.message];
    }
    return [];
  }

  return [err.message, ...collectErrorMessages(err.cause, seen)];
}
