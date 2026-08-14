import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFile = promisify(execFileCallback);
const GITHUB_API_URL = "https://api.github.com/user";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 10_000;
const CLI_CHECK_TIMEOUT_MS = 5_000;
const MAX_TOKEN_LENGTH = 4096;

const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().trim().min(1),
  avatar_url: z.string().url().nullable().optional(),
  type: z.string().trim().min(1).nullable().optional(),
});

export interface GithubIdentity {
  externalId: string;
  login: string;
  avatarUrl: string | null;
  accountType: string | null;
}

export type GithubVerificationErrorCode =
  | "INVALID_TOKEN"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "CLI_INTEGRATION_UNAVAILABLE";

export class GithubVerificationError extends Error {
  constructor(
    public readonly code: GithubVerificationErrorCode,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "GithubVerificationError";
  }
}

export function normalizeGithubToken(token: string): string {
  return token.trim();
}

export function validateGithubTokenInput(token: string): void {
  const normalized = normalizeGithubToken(token);
  if (!normalized) throw new GithubVerificationError("INVALID_TOKEN", "Enter a GitHub personal access token.", 400);
  if (normalized.length > MAX_TOKEN_LENGTH) {
    throw new GithubVerificationError("INVALID_TOKEN", "The GitHub personal access token is too long.", 400);
  }
}

export async function verifyGithubToken(
  token: string,
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<GithubIdentity> {
  validateGithubTokenInput(token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  try {
    const response = await (options.fetch ?? globalThis.fetch)(GITHUB_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${normalizeGithubToken(token)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "Sketch-GitHub-Integration",
      },
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (response.status === 403 && remaining === "0") {
        throw new GithubVerificationError("RATE_LIMITED", "GitHub rate limit reached. Try again later.", 429);
      }
      throw new GithubVerificationError("INVALID_TOKEN", "GitHub rejected this token.", 401);
    }
    if (response.status === 429) {
      throw new GithubVerificationError("RATE_LIMITED", "GitHub rate limit reached. Try again later.", 429);
    }
    if (!response.ok) {
      throw new GithubVerificationError("UPSTREAM_UNAVAILABLE", "GitHub could not verify the token.", 502);
    }

    const parsed = githubUserSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new GithubVerificationError(
        "UPSTREAM_UNAVAILABLE",
        "GitHub returned an unexpected verification response.",
        502,
      );
    }

    return {
      externalId: String(parsed.data.id),
      login: parsed.data.login,
      avatarUrl: parsed.data.avatar_url ?? null,
      accountType: parsed.data.type ?? null,
    };
  } catch (error) {
    if (error instanceof GithubVerificationError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new GithubVerificationError("UPSTREAM_UNAVAILABLE", "GitHub verification timed out.", 504);
    }
    throw new GithubVerificationError("UPSTREAM_UNAVAILABLE", "GitHub is unavailable. Try again later.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export interface GithubCliHealth {
  available: boolean;
  version: string | null;
  errorCode?: "missing" | "failed";
}

export async function checkGithubCli(): Promise<GithubCliHealth> {
  try {
    const result = await execFile("gh", ["--version"], {
      timeout: CLI_CHECK_TIMEOUT_MS,
      maxBuffer: 32 * 1024,
      env: { ...process.env, GH_TOKEN: undefined },
    });
    const version = result.stdout.trim().split(/\r?\n/, 1)[0] ?? null;
    return { available: true, version };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return { available: false, version: null, errorCode: code === "ENOENT" ? "missing" : "failed" };
  }
}

export async function assertGithubCliAvailable(): Promise<void> {
  const health = await checkGithubCli();
  if (!health.available) {
    throw new GithubVerificationError(
      "CLI_INTEGRATION_UNAVAILABLE",
      "GitHub CLI is unavailable on this Sketch deployment.",
      503,
    );
  }
}
