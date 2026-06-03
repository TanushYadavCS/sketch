/**
 * JWT signing and verification using jose (HS256).
 * Tokens are self-contained — no server-side session state needed.
 */
import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
const EXPIRY = "7d";

function secretToKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signJwt(sub: string, role: "admin" | "member", secret: string): Promise<string> {
  return new SignJWT({ sub, role })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(secretToKey(secret));
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<{ sub: string; role: "admin" | "member"; email?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secretToKey(secret));
    if (typeof payload.sub !== "string") return null;
    const role = payload.role === "member" ? "member" : "admin"; // default to admin for old tokens
    const result: { sub: string; role: "admin" | "member"; email?: string } = { sub: payload.sub, role };
    if (typeof payload.email === "string") {
      result.email = payload.email;
    }
    return result;
  } catch {
    return null;
  }
}
