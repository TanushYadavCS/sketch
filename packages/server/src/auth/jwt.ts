/**
 * JWT signing and verification using jose (HS256).
 * Tokens are self-contained — no server-side session state needed.
 */
import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
const EXPIRY = "7d";
type AuthRole = "admin" | "member";
type JwtPayload = { sub: string; role: AuthRole; email?: string };
type DetailedJwtPayload = JwtPayload & { roleClaim?: AuthRole };

function secretToKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signJwt(sub: string, role: AuthRole, secret: string): Promise<string> {
  return new SignJWT({ sub, role })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(secretToKey(secret));
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const payload = await verifyJwtWithRoleClaim(token, secret);
  if (!payload) return null;
  const { roleClaim: _roleClaim, ...result } = payload;
  return result;
}

export async function verifyJwtWithRoleClaim(token: string, secret: string): Promise<DetailedJwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretToKey(secret));
    if (typeof payload.sub !== "string") return null;
    const roleClaim =
      payload.role === "member" ? "member" : payload.role === "admin" || payload.role === "owner" ? "admin" : undefined;
    const role = roleClaim ?? "admin";
    const result: DetailedJwtPayload = {
      sub: payload.sub,
      role,
      ...(roleClaim ? { roleClaim } : {}),
    };
    if (typeof payload.email === "string") {
      result.email = payload.email;
    }
    return result;
  } catch {
    return null;
  }
}
