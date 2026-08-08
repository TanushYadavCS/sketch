const STOP_COMMANDS = new Set(["stop", "kill", "cancel"]);
const STOP_FILLERS = new Set(["please", "it", "the", "now", "just", "pls"]);

export function normalizeSlackStopCommand(text: string): string {
  const withoutMentions = text.replace(/<@[^>\s]+>/gu, " ");
  const withoutLinks = withoutMentions.replace(/<[^>\r\n]*\|[^>\r\n]*>/gu, " ");
  const words = withoutLinks
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0 && !STOP_FILLERS.has(word));
  return words.join(" ");
}

export function isSlackStopCommand(text: string): boolean {
  return STOP_COMMANDS.has(normalizeSlackStopCommand(text));
}
