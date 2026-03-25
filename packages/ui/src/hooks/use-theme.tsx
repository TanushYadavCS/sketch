/**
 * Theme provider supporting Dark / Light / System modes.
 * Persists user preference to localStorage. System mode tracks OS via matchMedia.
 * Default: system.
 */
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";

type ThemePreference = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

interface ThemeContext {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: ThemePreference) => void;
  logoSrc: string;
}

const ThemeContext = createContext<ThemeContext | undefined>(undefined);

const STORAGE_KEY = "sketch-theme";

const VALID_PREFS = new Set<ThemePreference>(["dark", "light", "system"]);

function getInitialTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_PREFS.has(stored as ThemePreference)) return stored as ThemePreference;
  } catch {}
  return "system";
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(getInitialTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));

  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    if (theme !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const resolved = resolveTheme("system");
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const logoSrc = resolvedTheme === "dark" ? "/assets/sketch.svg" : "/assets/sketch-dark.svg";

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme: setThemeState, logoSrc }),
    [theme, resolvedTheme, logoSrc],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
