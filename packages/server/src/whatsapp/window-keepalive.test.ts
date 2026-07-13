import { describe, expect, it } from "vitest";
import { buildWhatsAppWindowKeepAliveMessage, decideWhatsAppWindowKeepAlive } from "./window-keepalive";

const NOW = new Date("2026-07-04T12:00:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe("decideWhatsAppWindowKeepAlive", () => {
  it("skips users with no inbound WhatsApp DM", () => {
    expect(decideWhatsAppWindowKeepAlive({ latestInboundReceivedAt: null, now: NOW })).toBe("skip_no_inbound");
  });

  it("skips users whose customer service window is still healthy", () => {
    expect(decideWhatsAppWindowKeepAlive({ latestInboundReceivedAt: hoursAgo(20.99), now: NOW })).toBe("skip_recent");
  });

  it("sends within the 21h inclusive to 23h exclusive ping band", () => {
    expect(decideWhatsAppWindowKeepAlive({ latestInboundReceivedAt: hoursAgo(21), now: NOW })).toBe("send");
    expect(decideWhatsAppWindowKeepAlive({ latestInboundReceivedAt: hoursAgo(22.99), now: NOW })).toBe("send");
  });

  it("skips users whose customer service window has already lapsed", () => {
    expect(decideWhatsAppWindowKeepAlive({ latestInboundReceivedAt: hoursAgo(23), now: NOW })).toBe("skip_lapsed");
  });

  it("skips when a keep-alive was already sent since the latest inbound", () => {
    expect(
      decideWhatsAppWindowKeepAlive({
        latestInboundReceivedAt: hoursAgo(22),
        lastKeepAliveSentAt: hoursAgo(21.5),
        now: NOW,
      }),
    ).toBe("skip_deduped");
  });

  it("sends again after a newer inbound starts a new window cycle", () => {
    expect(
      decideWhatsAppWindowKeepAlive({
        latestInboundReceivedAt: hoursAgo(22),
        lastKeepAliveSentAt: hoursAgo(25),
        now: NOW,
      }),
    ).toBe("send");
  });
});

describe("buildWhatsAppWindowKeepAliveMessage", () => {
  it("mentions upcoming scheduled updates when tasks are due soon", () => {
    const message = buildWhatsAppWindowKeepAliveMessage({
      recipientName: "Priya",
      botName: "Canvas",
      upcomingTaskCount: 2,
    });

    expect(message).toContain("Hi Priya, Canvas here.");
    expect(message).toContain("2 scheduled updates");
    expect(message).toContain("reply with anything");
    expect(message).not.toContain("template");
  });

  it("uses the fallback notification copy when no tasks are due soon", () => {
    const message = buildWhatsAppWindowKeepAliveMessage({
      recipientName: "Amit",
      botName: "Sketch",
      upcomingTaskCount: 0,
    });

    expect(message).toContain("Hi Amit, Sketch here.");
    expect(message).toContain("almost a day");
    expect(message).toContain("short notification template");
    expect(message).not.toContain("scheduled update");
  });
});
