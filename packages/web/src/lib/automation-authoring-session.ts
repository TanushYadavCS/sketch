export type AutomationAuthoringNavigationType =
  | "reload"
  | "navigate"
  | "back_forward"
  | "prerender"
  | "replace"
  | "unknown";

export interface AutomationAuthoringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface AutomationAuthoringLifecycleTarget {
  addEventListener(type: "pagehide" | "pageshow", listener: () => void): void;
  removeEventListener(type: "pagehide" | "pageshow", listener: () => void): void;
}

export interface AutomationAuthoringSessionOptions {
  sessionStorage?: AutomationAuthoringStorage;
  localStorage?: AutomationAuthoringStorage;
  navigationType?: AutomationAuthoringNavigationType;
  now?: () => number;
  randomUUID?: () => string;
  claimTtlMs?: number;
  closingGraceMs?: number;
}

export interface AutomationAuthoringSession {
  readonly clientSessionId: string;
  readonly contextToken: string;
  isClaimed(): boolean;
  markPageHidden(): void;
  markPageVisible(): void;
  dispose(): void;
}

export const AUTOMATION_AUTHORING_SESSION_STORAGE_KEY = "sketch:automation-authoring-session";
export const AUTOMATION_AUTHORING_CLAIM_KEY_PREFIX = "sketch:automation-authoring-claim:";
export const AUTOMATION_AUTHORING_CLAIM_TTL_MS = 60_000;
export const AUTOMATION_AUTHORING_CLOSING_GRACE_MS = 10_000;

interface StoredSession {
  clientSessionId: string;
  contextToken: string;
}

interface SessionClaim {
  ownerToken: string;
  claimedAt: number;
  closingAt: number | null;
}

const browserStorage = (name: "sessionStorage" | "localStorage"): AutomationAuthoringStorage | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    return window[name];
  } catch {
    return undefined;
  }
};

function readJson<T>(storage: AutomationAuthoringStorage | undefined, key: string): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: AutomationAuthoringStorage | undefined, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

function validStoredSession(value: StoredSession | null): value is StoredSession {
  return Boolean(
    value &&
      typeof value.clientSessionId === "string" &&
      value.clientSessionId.trim() &&
      typeof value.contextToken === "string" &&
      value.contextToken.trim(),
  );
}

function validClaim(value: SessionClaim | null): value is SessionClaim {
  return Boolean(
    value &&
      typeof value.ownerToken === "string" &&
      value.ownerToken.trim() &&
      Number.isFinite(value.claimedAt) &&
      (value.closingAt === null || Number.isFinite(value.closingAt)),
  );
}

function storedSessionId(storage: AutomationAuthoringStorage | undefined): StoredSession | null {
  const value = readJson<StoredSession>(storage, AUTOMATION_AUTHORING_SESSION_STORAGE_KEY);
  return validStoredSession(value) ? value : null;
}

function createStoredSession(randomUUID: () => string): StoredSession {
  return { clientSessionId: randomUUID(), contextToken: randomUUID() };
}

function claimKey(clientSessionId: string): string {
  return `${AUTOMATION_AUTHORING_CLAIM_KEY_PREFIX}${clientSessionId}`;
}

function claimIsReusable(
  claim: SessionClaim | null,
  navigationType: AutomationAuthoringNavigationType,
  now: number,
  claimTtlMs: number,
  closingGraceMs: number,
): boolean {
  if (!claim) return true;
  if (navigationType === "reload") return true;
  if (claim.closingAt !== null && now - claim.closingAt <= closingGraceMs) return true;
  return now - claim.claimedAt > claimTtlMs;
}

export function createAutomationAuthoringSession(
  options: AutomationAuthoringSessionOptions = {},
): AutomationAuthoringSession {
  const sessionStorage = options.sessionStorage ?? browserStorage("sessionStorage");
  const localStorage = options.localStorage ?? browserStorage("localStorage");
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const navigationType = options.navigationType ?? "unknown";
  const claimTtlMs = options.claimTtlMs ?? AUTOMATION_AUTHORING_CLAIM_TTL_MS;
  const closingGraceMs = options.closingGraceMs ?? AUTOMATION_AUTHORING_CLOSING_GRACE_MS;
  const ownerToken = randomUUID();
  const stored = storedSessionId(sessionStorage) ?? createStoredSession(randomUUID);
  let current = stored;
  const claim = readJson<SessionClaim>(localStorage, claimKey(current.clientSessionId));
  if (
    validClaim(claim) &&
    claim.ownerToken !== ownerToken &&
    !claimIsReusable(claim, navigationType, now(), claimTtlMs, closingGraceMs)
  ) {
    current = createStoredSession(randomUUID);
  }
  writeJson(sessionStorage, AUTOMATION_AUTHORING_SESSION_STORAGE_KEY, current);

  const writeClaim = (closingAt: number | null): void => {
    writeJson(localStorage, claimKey(current.clientSessionId), {
      ownerToken,
      claimedAt: now(),
      closingAt,
    } satisfies SessionClaim);
  };
  writeClaim(null);

  let disposed = false;
  return {
    get clientSessionId() {
      return current.clientSessionId;
    },
    get contextToken() {
      return current.contextToken;
    },
    isClaimed() {
      if (disposed) return false;
      const observed = readJson<SessionClaim>(localStorage, claimKey(current.clientSessionId));
      return validClaim(observed) && observed.ownerToken === ownerToken;
    },
    markPageHidden() {
      if (disposed) return;
      writeClaim(now());
    },
    markPageVisible() {
      if (disposed) return;
      writeClaim(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        localStorage?.removeItem?.(claimKey(current.clientSessionId));
      } catch {
        return;
      }
    },
  };
}

export function bindAutomationAuthoringSessionLifecycle(
  session: AutomationAuthoringSession,
  target: AutomationAuthoringLifecycleTarget,
): () => void {
  const onPageHide = () => session.markPageHidden();
  const onPageShow = () => session.markPageVisible();
  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);
  return () => {
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  };
}
