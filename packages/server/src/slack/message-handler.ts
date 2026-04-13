/**
 * Factories for the onFinalMessage and onToolProgress callbacks passed to
 * runAgent(). onFinalMessage posts new messages (chunked if needed).
 * onToolProgress posts and edits a single progress message with accumulated
 * tool call lines.
 *
 * Messages exceeding Slack's 40k char limit are split into chunks.
 */
import { chunkText } from "../formatting/chunking";
import type { SlackBot } from "./bot";

const SLACK_TEXT_LIMIT = 39_000;
const PROGRESS_THROTTLE_MS = 1_500;

export function createSlackMessageHandler(
  slackBot: SlackBot,
  channelId: string,
  threadTs?: string,
): (text: string) => Promise<void> {
  return async (text: string) => {
    const chunks = chunkText(text, SLACK_TEXT_LIMIT);
    for (const chunk of chunks) {
      if (threadTs) {
        await slackBot.postThreadReply(channelId, threadTs, chunk);
      } else {
        await slackBot.postMessage(channelId, chunk);
      }
    }
  };
}

/**
 * Creates a throttled tool progress handler that posts a single message and
 * edits it in place as tool calls accumulate. First call posts immediately,
 * subsequent calls are throttled to avoid Slack API rate limits.
 */
export function createSlackToolProgressHandler(
  slackBot: SlackBot,
  channelId: string,
  threadTs?: string,
): (lines: string[]) => Promise<void> {
  let progressTs: string | null = null;
  let lastEditAt = 0;
  let pendingLines: string[] | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const doEdit = async (lines: string[]) => {
    const text = lines.join("\n");
    if (!progressTs) {
      progressTs = threadTs
        ? await slackBot.postThreadReply(channelId, threadTs, text)
        : await slackBot.postMessage(channelId, text);
    } else {
      await slackBot.updateMessage(channelId, progressTs, text);
    }
    lastEditAt = Date.now();
    pendingLines = null;
  };

  return async (lines: string[]) => {
    const now = Date.now();
    const elapsed = now - lastEditAt;

    if (elapsed >= PROGRESS_THROTTLE_MS) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      await doEdit(lines);
    } else {
      pendingLines = lines;
      if (!pendingTimer) {
        pendingTimer = setTimeout(async () => {
          pendingTimer = null;
          if (pendingLines) {
            try {
              await doEdit(pendingLines);
            } catch {}
          }
        }, PROGRESS_THROTTLE_MS - elapsed);
      }
    }
  };
}
