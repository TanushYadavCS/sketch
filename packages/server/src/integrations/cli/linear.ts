import { z } from "zod";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_API_KEY_LENGTH = 4096;

const linearViewerSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).nullable().optional(),
  email: z.string().trim().min(1).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

const linearResponseSchema = z.object({
  data: z.object({ viewer: linearViewerSchema.nullable() }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export interface LinearIdentity {
  externalId: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  accountType: string | null;
}

export type LinearVerificationErrorCode = "INVALID_TOKEN" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE";

export class LinearVerificationError extends Error {
  constructor(
    public readonly code: LinearVerificationErrorCode,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "LinearVerificationError";
  }
}

export function normalizeLinearApiKey(apiKey: string): string {
  return apiKey.trim();
}

export function validateLinearApiKeyInput(apiKey: string): void {
  const normalized = normalizeLinearApiKey(apiKey);
  if (!normalized) throw new LinearVerificationError("INVALID_TOKEN", "Enter a Linear personal API key.", 400);
  if (normalized.length > MAX_API_KEY_LENGTH) {
    throw new LinearVerificationError("INVALID_TOKEN", "The Linear personal API key is too long.", 400);
  }
}

export async function verifyLinearApiKey(
  apiKey: string,
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<LinearIdentity> {
  validateLinearApiKeyInput(apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  try {
    const response = await (options.fetch ?? globalThis.fetch)(LINEAR_API_URL, {
      method: "POST",
      headers: {
        Authorization: normalizeLinearApiKey(apiKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: "query Viewer { viewer { id name email avatarUrl } }" }),
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new LinearVerificationError("INVALID_TOKEN", "Linear rejected this API key.", 401);
    }
    if (response.status === 429) {
      throw new LinearVerificationError("RATE_LIMITED", "Linear rate limit reached. Try again later.", 429);
    }
    if (!response.ok) {
      throw new LinearVerificationError("UPSTREAM_UNAVAILABLE", "Linear could not verify the API key.", 502);
    }

    const parsed = linearResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new LinearVerificationError(
        "UPSTREAM_UNAVAILABLE",
        "Linear returned an unexpected verification response.",
        502,
      );
    }
    const errorMessage = parsed.data.errors?.map((error) => error.message).join(" ") ?? "";
    if (errorMessage) {
      if (/rate.?limit|too many requests/i.test(errorMessage)) {
        throw new LinearVerificationError("RATE_LIMITED", "Linear rate limit reached. Try again later.", 429);
      }
      if (/api.?key|unauthori[sz]ed|authentication|invalid token/i.test(errorMessage)) {
        throw new LinearVerificationError("INVALID_TOKEN", "Linear rejected this API key.", 401);
      }
      throw new LinearVerificationError("UPSTREAM_UNAVAILABLE", "Linear could not verify the API key.", 502);
    }
    if (!parsed.data.data?.viewer) {
      throw new LinearVerificationError(
        "UPSTREAM_UNAVAILABLE",
        "Linear returned an unexpected verification response.",
        502,
      );
    }
    const viewer = parsed.data.data.viewer;
    return {
      externalId: viewer.id,
      login: viewer.name ?? viewer.email ?? viewer.id,
      name: viewer.name ?? null,
      email: viewer.email ?? null,
      avatarUrl: viewer.avatarUrl ?? null,
      accountType: "User",
    };
  } catch (error) {
    if (error instanceof LinearVerificationError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new LinearVerificationError("UPSTREAM_UNAVAILABLE", "Linear verification timed out.", 504);
    }
    throw new LinearVerificationError("UPSTREAM_UNAVAILABLE", "Linear is unavailable. Try again later.", 502);
  } finally {
    clearTimeout(timeout);
  }
}
