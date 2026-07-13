import { describe, expect, it } from "vitest";
import type { StoredConversationMessage } from "../../db/repositories/conversations";
import { type WhatsAppRosterSnapshot, stableWhatsAppParticipantJidRef } from "../../whatsapp/identity-resolution";
import {
  MAX_WHATSAPP_GROUP_HISTORY_EXPAND_MINUTES,
  MAX_WHATSAPP_GROUP_HISTORY_LIMIT,
  MAX_WHATSAPP_GROUP_HISTORY_WINDOW_MINUTES,
  buildWhatsAppGroupHistoryWindow,
  normalizeWhatsAppGroupHistoryExpandMinutes,
  normalizeWhatsAppGroupHistoryLimit,
  renderWhatsAppGroupHistoryMessages,
} from "./whatsapp-group-history";

const RAW_IDENTIFIER_PATTERN = /(?:\+?[1-9]\d{9,14}\b|@s\.whatsapp\.net|@lid|\/tmp\/|\/data\/workspaces\/)/iu;
const EXTERNAL_PHONE_FORM_PATTERN = /External\s+\+/u;
const DIGIT_RUN_PATTERN = /\d{3,}/u;

function message(overrides: Partial<StoredConversationMessage> = {}): StoredConversationMessage {
  return {
    id: 1,
    conversationId: 10,
    providerMessageId: "m1",
    senderJid: "15550000001@s.whatsapp.net",
    senderName: "Tara Teammate",
    senderUserId: null,
    isBot: false,
    addressedToSketch: false,
    text: "Project Atlas starts Monday.",
    attachments: [],
    providerThreadId: null,
    providerParentMessageId: null,
    isThreadReply: false,
    providerTimestamp: "2026-07-07T09:00:00.000Z",
    receivedAt: "2026-07-07T09:00:01.000Z",
    createdAt: "2026-07-07T09:00:01.000Z",
    ...overrides,
  };
}

function rosterSnapshot(): WhatsAppRosterSnapshot {
  const teammateJid = "15550000001@s.whatsapp.net";
  return {
    participants: [
      {
        participantJidRef: stableWhatsAppParticipantJidRef(teammateJid),
        senderJidRefs: [stableWhatsAppParticipantJidRef(teammateJid)],
        displayName: "Tara Teammate +15550000001",
        resolutionKind: "teammate",
        adminRole: null,
        userId: "user-tara",
      },
    ],
    resolutionCounts: { totalParticipants: 1, teammate: 1, entity: 0, labeled: 0, unresolved: 0 },
  };
}

describe("WhatsAppGroupHistory renderer", () => {
  it("renders safe sender names and type-only attachments without metadata leaks", () => {
    const rendered = renderWhatsAppGroupHistoryMessages(rosterSnapshot(), [
      message({
        text: "Call +15550000001 or open /tmp/raw-message.txt before Monday.",
        attachments: [
          {
            originalName: "15550000001-secret-photo.jpg",
            mimeType: "image/jpeg",
            localPath: "/data/workspaces/u1/attachments/15550000001-secret-photo.jpg",
            sizeBytes: 123,
          },
        ],
      }),
      message({
        id: 2,
        senderJid: "abc123@lid",
        senderName: "External +15550000002 /tmp/raw.jpg",
        text: "Adjacent banter that should remain visible.",
        attachments: [
          {
            originalName: "voice-from-15550000002.ogg",
            mimeType: "audio/ogg",
            localPath: "/tmp/voice-from-15550000002.ogg",
            sizeBytes: 456,
          },
        ],
      }),
    ]);

    const serialized = JSON.stringify(rendered);
    const renderedSenders = rendered.map((row) => String(row.sender)).join(" ");
    expect(serialized).not.toMatch(RAW_IDENTIFIER_PATTERN);
    expect(renderedSenders).not.toMatch(EXTERNAL_PHONE_FORM_PATTERN);
    expect(renderedSenders).not.toMatch(DIGIT_RUN_PATTERN);
    expect(renderedSenders).not.toMatch(/\d/u);
    expect(rendered).toEqual([
      expect.objectContaining({
        sender: "Tara Teammate",
        text: "Call or open [file] before Monday.",
        attachments: ["[image]"],
      }),
      expect.objectContaining({
        sender: `External (${stableWhatsAppParticipantJidRef("abc123@lid").slice(0, 12)})`,
        text: "Adjacent banter that should remain visible.",
        attachments: ["[audio]"],
      }),
    ]);
  });
});

describe("WhatsAppGroupHistory window math", () => {
  it("defaults and caps expansion minutes", () => {
    expect(normalizeWhatsAppGroupHistoryExpandMinutes(undefined)).toBe(30);
    expect(normalizeWhatsAppGroupHistoryExpandMinutes(999)).toBe(MAX_WHATSAPP_GROUP_HISTORY_EXPAND_MINUTES);
  });

  it("caps message limit", () => {
    expect(normalizeWhatsAppGroupHistoryLimit(undefined)).toBe(100);
    expect(normalizeWhatsAppGroupHistoryLimit(999)).toBe(MAX_WHATSAPP_GROUP_HISTORY_LIMIT);
  });

  it("expands slice windows before and after the anchor", () => {
    expect(buildWhatsAppGroupHistoryWindow("2026-07-07T09:00:00.000Z", "2026-07-07T09:10:00.000Z", 10)).toEqual({
      start: "2026-07-07T08:50:00.000Z",
      end: "2026-07-07T09:20:00.000Z",
      expandMinutes: 10,
    });
  });

  it("caps direct group windows to 24 hours after expansion", () => {
    const window = buildWhatsAppGroupHistoryWindow("2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z", 240, {
      maxWindowMinutes: MAX_WHATSAPP_GROUP_HISTORY_WINDOW_MINUTES,
    });

    expect(window).toEqual({
      start: "2026-07-06T20:00:00.000Z",
      end: "2026-07-07T20:00:00.000Z",
      expandMinutes: 240,
    });
  });

  it("rejects invalid or inverted windows", () => {
    expect(buildWhatsAppGroupHistoryWindow("not a date", "2026-07-07T09:10:00.000Z", 10)).toBeNull();
    expect(buildWhatsAppGroupHistoryWindow("2026-07-07T09:10:00.000Z", "2026-07-07T09:00:00.000Z", 10)).toBeNull();
  });
});
