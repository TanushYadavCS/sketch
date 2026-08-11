import { describe, expect, it } from "vitest";
import {
  WEBHOOK_BODY_LIMIT_BYTES,
  WEBHOOK_EVENT_ID_MAX_LENGTH,
  WEBHOOK_SIGNATURE_MAX_SKEW_SECONDS,
  createWebhookSignature,
  verifyWebhookAuth,
  verifyWebhookSignature,
} from "./webhook-auth";

const SECRET = "native-webhook-secret";
const BODY = '{"event":"created"}';
const NOW = 1_750_000_000;

describe("native webhook authentication", () => {
  it("accepts bearer credentials with a constant-time-safe comparison", () => {
    expect(
      verifyWebhookAuth({
        secret: SECRET,
        rawBody: BODY,
        authorization: `Bearer ${SECRET}`,
        now: NOW,
      }),
    ).toEqual({ ok: true, scheme: "bearer" });
    expect(verifyWebhookAuth({ secret: SECRET, rawBody: BODY, authorization: "Bearer wrong", now: NOW })).toEqual({
      ok: false,
      code: "invalid_bearer",
      scheme: "bearer",
    });
  });

  it("signs the exact raw body and verifies lowercase hexadecimal HMAC signatures", () => {
    const signature = createWebhookSignature(SECRET, BODY, NOW);
    expect(signature).toMatch(/^t=1750000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(SECRET, BODY, signature, NOW)).toEqual({ ok: true, scheme: "hmac", timestamp: NOW });
    expect(verifyWebhookSignature(SECRET, `${BODY} `, signature, NOW)).toMatchObject({
      ok: false,
      code: "invalid_signature",
    });
    expect(verifyWebhookSignature(SECRET, BODY, signature.toUpperCase(), NOW)).toMatchObject({
      ok: false,
      code: "malformed_signature",
    });
  });

  it("rejects signatures outside the five-minute timestamp window", () => {
    const signature = createWebhookSignature(SECRET, BODY, NOW - WEBHOOK_SIGNATURE_MAX_SKEW_SECONDS - 1);
    expect(verifyWebhookSignature(SECRET, BODY, signature, NOW)).toEqual({
      ok: false,
      code: "expired_signature",
      scheme: "hmac",
    });
  });

  it("exports the ingress bounds used by the route", () => {
    expect(WEBHOOK_BODY_LIMIT_BYTES).toBe(1_000_000);
    expect(WEBHOOK_EVENT_ID_MAX_LENGTH).toBe(200);
  });
});
