import {
  type ProgressTransport,
  type ProgressTransportStrategy,
  createProgressTransport,
} from "../agent/progress-transport";
import type { SlackBot } from "./bot";

// Slack progress messages are edited in place via chat.update, which rejects
// text payloads above 4,000 characters with `msg_too_long`.
const SLACK_PROGRESS_LIMIT = 4_000;
const PROGRESS_THROTTLE_MS = 1_500;

export function createSlackProgressTransport(
  slackBot: SlackBot,
  channelId: string,
  strategy: ProgressTransportStrategy,
  threadTs?: string,
): ProgressTransport {
  return createProgressTransport({
    charLimit: SLACK_PROGRESS_LIMIT,
    throttleMs: PROGRESS_THROTTLE_MS,
    strategy,
    postText: async (text) =>
      threadTs ? slackBot.postThreadReply(channelId, threadTs, text) : slackBot.postMessage(channelId, text),
    editText: async (ref, text) => {
      await slackBot.updateMessage(channelId, ref, text);
    },
  });
}
