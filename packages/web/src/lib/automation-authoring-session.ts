export type AutomationAuthoringNavigationType = "navigate" | "reload" | "back_forward" | "prerender" | "unknown";

export interface AutomationAuthoringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const AUTOMATION_AUTHORING_SESSION_STORAGE_KEY = "sketch:automation-authoring-session:v1";

function isReusableNavigation(navigationType: AutomationAuthoringNavigationType): boolean {
  return navigationType === "reload" || navigationType === "back_forward";
}

export function resolveAutomationAuthoringSessionId({
  navigationType,
  storage,
  randomUUID,
}: {
  navigationType: AutomationAuthoringNavigationType;
  storage?: AutomationAuthoringStorage;
  randomUUID: () => string;
}): string {
  if (storage && isReusableNavigation(navigationType)) {
    try {
      const stored = storage.getItem(AUTOMATION_AUTHORING_SESSION_STORAGE_KEY);
      if (stored) return stored;
    } catch {
      return randomUUID();
    }
  }

  const sessionId = randomUUID();
  try {
    storage?.setItem(AUTOMATION_AUTHORING_SESSION_STORAGE_KEY, sessionId);
  } catch {
    return sessionId;
  }
  return sessionId;
}

let documentSessionId: string | undefined;

function browserStorage(): AutomationAuthoringStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function browserNavigationType(): AutomationAuthoringNavigationType {
  if (typeof performance === "undefined") return "unknown";
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type ?? "unknown";
  } catch {
    return "unknown";
  }
}

function browserRandomUUID(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

export function getAutomationAuthoringSessionId(): string {
  if (documentSessionId) return documentSessionId;
  documentSessionId = resolveAutomationAuthoringSessionId({
    navigationType: browserNavigationType(),
    storage: browserStorage(),
    randomUUID: browserRandomUUID,
  });
  return documentSessionId;
}
