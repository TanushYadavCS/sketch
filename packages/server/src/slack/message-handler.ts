/**
 * Final message delivery helpers for Slack.
 *
 * Messages exceeding Slack's 40k char limit are split into chunks.
 */
import { chunkText } from "../formatting/chunking";
import type { SlackBot } from "./bot";

const SLACK_TEXT_LIMIT = 39_000;

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
