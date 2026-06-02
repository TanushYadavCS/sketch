/**
 * Final message delivery helpers for Slack.
 *
 * Messages exceeding Slack's 40k char limit are split into chunks.
 */
import { chunkText } from "../formatting/chunking";
import type { SlackBot } from "./bot";

const SLACK_TEXT_LIMIT = 39_000;

export interface SentSlackMessage {
  messageRef: string;
  text: string;
}

export function createSlackMessageHandler(
  slackBot: SlackBot,
  channelId: string,
  threadTs?: string,
): (text: string) => Promise<SentSlackMessage[]> {
  return async (text: string) => {
    const chunks = chunkText(text, SLACK_TEXT_LIMIT);
    const sent: SentSlackMessage[] = [];
    for (const chunk of chunks) {
      if (threadTs) {
        sent.push({ messageRef: await slackBot.postThreadReply(channelId, threadTs, chunk), text: chunk });
      } else {
        sent.push({ messageRef: await slackBot.postMessage(channelId, chunk), text: chunk });
      }
    }
    return sent;
  };
}
