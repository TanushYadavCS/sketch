import { describe, expect, it, vi } from "vitest";
import { createEmailTransport, sendVerificationEmail, verifyEmailTransport } from "./email";

vi.mock("nodemailer", () => {
  const createTransport = vi.fn((opts: Record<string, unknown>) => ({
    _opts: opts,
    verify: vi.fn(),
    sendMail: vi.fn(),
  }));
  return { default: { createTransport } };
});

import nodemailer from "nodemailer";

function getLastTransport() {
  const calls = vi.mocked(nodemailer.createTransport).mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

function makeMockTransport(overrides?: { verify?: () => Promise<void>; sendMail?: () => Promise<void> }) {
  return {
    verify: overrides?.verify ?? vi.fn().mockResolvedValue(true),
    sendMail: overrides?.sendMail ?? vi.fn().mockResolvedValue({ messageId: "abc" }),
  } as unknown as ReturnType<typeof nodemailer.createTransport>;
}

describe("createEmailTransport()", () => {
  it("passes host and port to nodemailer", () => {
    createEmailTransport({ host: "smtp.example.com", port: 587, user: "u", password: "p", from: "a@b.com" });
    const opts = getLastTransport();
    expect(opts.host).toBe("smtp.example.com");
    expect(opts.port).toBe(587);
  });

  it("sets secure=true for port 465", () => {
    createEmailTransport({ host: "smtp.example.com", port: 465, user: "u", password: "p", from: "a@b.com" });
    const opts = getLastTransport();
    expect(opts.secure).toBe(true);
  });

  it("sets secure=false for port 587", () => {
    createEmailTransport({ host: "smtp.example.com", port: 587, user: "u", password: "p", from: "a@b.com" });
    const opts = getLastTransport();
    expect(opts.secure).toBe(false);
  });

  it("sets secure=false for non-465 ports", () => {
    createEmailTransport({ host: "smtp.example.com", port: 25, user: "u", password: "p", from: "a@b.com" });
    const opts = getLastTransport();
    expect(opts.secure).toBe(false);
  });

  it("passes auth credentials", () => {
    createEmailTransport({
      host: "smtp.example.com",
      port: 587,
      user: "me@gmail.com",
      password: "s3cret",
      from: "a@b.com",
    });
    const opts = getLastTransport();
    expect(opts.auth).toEqual({ user: "me@gmail.com", pass: "s3cret" });
  });
});

describe("verifyEmailTransport()", () => {
  it("returns true when transport.verify() succeeds", async () => {
    const transport = makeMockTransport({ verify: vi.fn().mockResolvedValue(true) });
    const result = await verifyEmailTransport(transport);
    expect(result).toBe(true);
  });

  it("returns false when transport.verify() throws", async () => {
    const transport = makeMockTransport({ verify: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    const result = await verifyEmailTransport(transport);
    expect(result).toBe(false);
  });

  it("calls transport.verify()", async () => {
    const verifyFn = vi.fn().mockResolvedValue(true);
    const transport = makeMockTransport({ verify: verifyFn });
    await verifyEmailTransport(transport);
    expect(verifyFn).toHaveBeenCalledOnce();
  });
});

describe("sendVerificationEmail()", () => {
  it("calls sendMail with correct from, to, subject", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "123" });
    const transport = makeMockTransport({ sendMail });

    await sendVerificationEmail(
      transport,
      "user@example.com",
      "https://app.test/verify?token=abc",
      "Sketch",
      "noreply@test.com",
    );

    expect(sendMail).toHaveBeenCalledOnce();
    const args = sendMail.mock.calls[0][0];
    expect(args.from).toBe("Sketch <noreply@test.com>");
    expect(args.to).toBe("user@example.com");
    expect(args.subject).toBe("Verify your email address");
  });

  it("includes the verification URL in the HTML body", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "123" });
    const transport = makeMockTransport({ sendMail });
    const url = "https://app.test/verify?token=xyz789";

    await sendVerificationEmail(transport, "user@example.com", url, "Bot", "no-reply@test.com");

    const html = sendMail.mock.calls[0][0].html as string;
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(url);
  });

  it("includes expiry notice in the HTML body", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "123" });
    const transport = makeMockTransport({ sendMail });

    await sendVerificationEmail(transport, "user@example.com", "https://x.com/v", "Bot", "a@b.com");

    const html = sendMail.mock.calls[0][0].html as string;
    expect(html).toContain("24 hours");
  });

  it("uses bot name in the from field", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "123" });
    const transport = makeMockTransport({ sendMail });

    await sendVerificationEmail(transport, "u@e.com", "https://x.com/v", "My Company Bot", "bot@company.com");

    const from = sendMail.mock.calls[0][0].from;
    expect(from).toBe("My Company Bot <bot@company.com>");
  });

  it("propagates sendMail errors", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("SMTP send failed"));
    const transport = makeMockTransport({ sendMail });

    await expect(sendVerificationEmail(transport, "u@e.com", "https://x.com/v", "Bot", "a@b.com")).rejects.toThrow(
      "SMTP send failed",
    );
  });
});
