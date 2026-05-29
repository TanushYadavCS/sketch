/**
 * In-memory buffer for group messages where the bot is not mentioned.
 *
 * Non-mention messages are buffered per group JID. When the bot is next
 * @mentioned, the buffer is drained and prepended to the user prompt so the
 * agent has context of the recent group conversation. Oldest messages are
 * evicted when the buffer exceeds maxPerGroup.
 */

import type { Attachment } from "../files";

export interface GroupBufferedMessage {
  senderName: string;
  text: string;
  timestamp: number;
  attachments?: Attachment[];
}

export class GroupBuffer {
  private buffers = new Map<string, GroupBufferedMessage[]>();
  private maxPerGroup: number;

  constructor(maxPerGroup = 50) {
    this.maxPerGroup = maxPerGroup;
  }

  append(groupJid: string, message: GroupBufferedMessage): void {
    let buf = this.buffers.get(groupJid);
    if (!buf) {
      buf = [];
      this.buffers.set(groupJid, buf);
    }
    buf.push(message);
    if (buf.length > this.maxPerGroup) {
      buf.splice(0, buf.length - this.maxPerGroup);
    }
  }

  drain(groupJid: string): GroupBufferedMessage[] {
    const buf = this.buffers.get(groupJid);
    if (!buf) return [];
    const messages = [...buf];
    buf.length = 0;
    return messages;
  }

  clear(groupJid: string): void {
    this.buffers.set(groupJid, []);
  }
}
