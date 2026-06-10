import { createHash, randomBytes, randomUUID } from "node:crypto";
import { generatePrefixedToken, hashApiToken } from "./api-token";

const CLIENT_ID_PREFIX = "skc_";
const CLIENT_SECRET_PREFIX = "sks_";
const AUTH_CODE_PREFIX = "skac_";
const CODE_TTL_MS = 60_000;

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function generateOAuthClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

export function generateOAuthClientSecret(): string {
  return generatePrefixedToken(CLIENT_SECRET_PREFIX);
}

export function generateAuthorizationCode(): string {
  return `${AUTH_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashOAuthSecret(value: string): string {
  return hashApiToken(value);
}

export function getAuthorizationCodeExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + CODE_TTL_MS).toISOString();
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  return base64UrlSha256(verifier) === challenge;
}
