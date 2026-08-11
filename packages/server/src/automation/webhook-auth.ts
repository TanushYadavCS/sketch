import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_ENDPOINT_PATH = "/api/webhooks/v1";
export const WEBHOOK_SIGNATURE_HEADER = "X-Sketch-Webhook-Signature";
export const WEBHOOK_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const WEBHOOK_EVENT_ID_HEADER = WEBHOOK_IDEMPOTENCY_KEY_HEADER;
export const WEBHOOK_BODY_LIMIT_BYTES = 1_000_000;
export const WEBHOOK_MAX_BODY_BYTES = WEBHOOK_BODY_LIMIT_BYTES;
export const WEBHOOK_REQUEST_BODY_LIMIT_BYTES = WEBHOOK_BODY_LIMIT_BYTES;
export const WEBHOOK_SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;
export const WEBHOOK_TIMESTAMP_SKEW_SECONDS = WEBHOOK_SIGNATURE_MAX_SKEW_SECONDS;
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = WEBHOOK_SIGNATURE_MAX_SKEW_SECONDS;
export const WEBHOOK_EVENT_ID_MAX_LENGTH = 200;
export const WEBHOOK_IDEMPOTENCY_KEY_MAX_LENGTH = WEBHOOK_EVENT_ID_MAX_LENGTH;

export type WebhookAuthScheme = "bearer" | "hmac";

export type WebhookAuthErrorCode =
  | "missing_credentials"
  | "malformed_bearer"
  | "invalid_bearer"
  | "malformed_signature"
  | "expired_signature"
  | "invalid_signature";

export interface WebhookAuthSuccess {
  readonly ok: true;
  readonly scheme: WebhookAuthScheme;
  readonly timestamp?: number;
}

export interface WebhookAuthFailure {
  readonly ok: false;
  readonly code: WebhookAuthErrorCode;
  readonly scheme?: WebhookAuthScheme;
}

export type WebhookAuthResult = WebhookAuthSuccess | WebhookAuthFailure;

export class WebhookAuthError extends Error {
  constructor(
    public readonly code: WebhookAuthErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "WebhookAuthError";
  }
}

export interface WebhookAuthHeaders {
  readonly authorization?: string | null;
  readonly signature?: string | null;
  readonly [name: string]: string | string[] | undefined | null;
}

export type WebhookRawBody = string | Uint8Array;

export interface VerifyWebhookAuthInput {
  readonly secret: string;
  readonly rawBody: WebhookRawBody;
  readonly authorization?: string | null;
  readonly signature?: string | null;
  readonly signatureHeader?: string | null;
  readonly headers?: Headers | WebhookAuthHeaders | Record<string, string | string[] | undefined | null>;
  readonly now?: number | Date;
}

function headerValue(headers: VerifyWebhookAuthInput["headers"], name: string): string | null | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name);
  const entries = Object.entries(headers);
  const entry = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
  if (!entry) return undefined;
  return Array.isArray(entry[1]) ? entry[1][0] : entry[1];
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function nowInSeconds(value: number | Date | undefined): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
  return Math.floor(Date.now() / 1000);
}

function signatureFor(secret: string, rawBody: WebhookRawBody, timestamp: number): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(body).digest("hex");
}

export function createWebhookSignature(
  secretOrInput: string | { readonly secret: string; readonly rawBody: WebhookRawBody; readonly timestamp?: number },
  rawBody?: WebhookRawBody,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  if (typeof secretOrInput === "string") {
    if (rawBody === undefined) throw new TypeError("rawBody is required");
    return `t=${timestamp},v1=${signatureFor(secretOrInput, rawBody, timestamp)}`;
  }
  const signedAt = secretOrInput.timestamp ?? Math.floor(Date.now() / 1000);
  return `t=${signedAt},v1=${signatureFor(secretOrInput.secret, secretOrInput.rawBody, signedAt)}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: WebhookRawBody,
  signatureHeader: string | null | undefined,
  now?: number | Date,
): WebhookAuthResult {
  if (!signatureHeader) return { ok: false, code: "missing_credentials", scheme: "hmac" };
  const match = /^t=([0-9]+),v1=([0-9a-f]{64})$/.exec(signatureHeader);
  if (!match) return { ok: false, code: "malformed_signature", scheme: "hmac" };
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp)) return { ok: false, code: "malformed_signature", scheme: "hmac" };
  if (Math.abs(nowInSeconds(now) - timestamp) > WEBHOOK_SIGNATURE_MAX_SKEW_SECONDS) {
    return { ok: false, code: "expired_signature", scheme: "hmac" };
  }
  const expected = signatureFor(secret, rawBody, timestamp);
  if (!constantTimeEqual(match[2], expected)) return { ok: false, code: "invalid_signature", scheme: "hmac" };
  return { ok: true, scheme: "hmac", timestamp };
}

export function verifyWebhookAuth(input: VerifyWebhookAuthInput): WebhookAuthResult {
  const authorization = input.authorization ?? headerValue(input.headers, "authorization");
  const signature =
    input.signature ?? input.signatureHeader ?? headerValue(input.headers, WEBHOOK_SIGNATURE_HEADER.toLowerCase());

  if (authorization !== undefined && authorization !== null && authorization.length > 0) {
    if (!/^Bearer [^\s]+$/i.test(authorization)) return { ok: false, code: "malformed_bearer", scheme: "bearer" };
    const token = authorization.slice("Bearer ".length);
    return constantTimeEqual(token, input.secret)
      ? { ok: true, scheme: "bearer" }
      : { ok: false, code: "invalid_bearer", scheme: "bearer" };
  }

  return verifyWebhookSignature(input.secret, input.rawBody, signature, input.now);
}

export const verifyWebhookRequest = verifyWebhookAuth;

export function classifyWebhookAuthError(error: unknown): WebhookAuthErrorCode | "unknown" {
  return error instanceof WebhookAuthError ? error.code : "unknown";
}
