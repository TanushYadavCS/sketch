import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw";

/**
 * Stub heavy icon libraries. Their barrel exports pull in thousands of files
 * that dominate import time, and no test asserts on icon rendering.
 * Returns a minimal <svg> so querySelector("svg") still works in tests.
 */
const { createElement } = await import("react");
const iconStub = () => createElement("svg");
const iconProxy = new Proxy(
  {},
  {
    get: (_, name) => {
      if (name === "__esModule") return true;
      if (typeof name === "symbol" || name === "then" || name === "default") return undefined;
      return iconStub;
    },
    has: (_, name) => name !== "then" && name !== "default" && typeof name === "string",
  },
);
vi.mock("@phosphor-icons/react", () => iconProxy);
vi.mock("lucide-react", () => iconProxy);

// IntersectionObserver is not available in jsdom — provide a no-op stub so
// components that use scroll detection don't crash when rendered in tests.
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

// EventSource is not available in jsdom — provide a no-op stub so components
// that use SSE (e.g. WhatsAppQR) don't crash when rendered in tests.
if (typeof globalThis.EventSource === "undefined") {
  globalThis.EventSource = class EventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    url: string;
    withCredentials = false;
    onopen: ((this: EventSource, ev: Event) => void) | null = null;
    onmessage: ((this: EventSource, ev: MessageEvent) => void) | null = null;
    onerror: ((this: EventSource, ev: Event) => void) | null = null;
    constructor(url: string | URL) {
      super();
      this.url = typeof url === "string" ? url : url.toString();
    }
    close() {
      this.readyState = 2;
    }
  } as unknown as typeof EventSource;
}

// window.matchMedia is not available in jsdom — stub it so hooks that use
// matchMedia (useTheme system mode, useIsMobile) do not throw.
if (typeof window.matchMedia === "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
