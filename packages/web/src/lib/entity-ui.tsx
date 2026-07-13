/**
 * Cross-app entity surface — accent helpers, avatar/chip primitives, and the
 * EntityUiProvider context that lets any chip anywhere open the drawer
 * without prop drilling.
 *
 * Pattern lifted from ow-dmt's lib/people-ui.tsx. The provider keeps a stack
 * of open entity ids so a `RelatedEntityPill` inside the drawer can push a
 * deeper view and the header's Back chip can pop.
 */
import { cn } from "@sketch/ui/lib/utils";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import type { DrawerEntityType } from "./api";

export interface EntityIdentity {
  id: string;
  name: string;
  /** Either the raw `sourceType` (e.g. "clickup_space") or the normalized drawer type ("system"). */
  sourceType: string;
  entityType?: DrawerEntityType;
}

type DrawerMode = "drawer" | "popover";

interface EntityUiContextValue {
  stack: string[];
  mode: DrawerMode;
  openEntity: (id: string, opts?: { mode?: DrawerMode }) => void;
  pushEntity: (id: string) => void;
  popEntity: () => void;
  closeAll: () => void;
}

const EntityUiContext = createContext<EntityUiContextValue | null>(null);

export function EntityUiProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<string[]>([]);
  const [mode, setMode] = useState<DrawerMode>("drawer");

  const openEntity = useCallback((id: string, opts?: { mode?: DrawerMode }) => {
    setMode(opts?.mode ?? "drawer");
    setStack([id]);
  }, []);

  const pushEntity = useCallback((id: string) => {
    setMode("drawer");
    setStack((s) => (s.length >= 5 ? [id] : [...s, id]));
  }, []);

  const popEntity = useCallback(() => {
    setStack((s) => s.slice(0, -1));
  }, []);

  const closeAll = useCallback(() => {
    setStack([]);
  }, []);

  const value = useMemo(
    () => ({ stack, mode, openEntity, pushEntity, popEntity, closeAll }),
    [stack, mode, openEntity, pushEntity, popEntity, closeAll],
  );

  return <EntityUiContext.Provider value={value}>{children}</EntityUiContext.Provider>;
}

export function useEntityUi(): EntityUiContextValue {
  const ctx = useContext(EntityUiContext);
  if (!ctx) throw new Error("useEntityUi must be used inside EntityUiProvider");
  return ctx;
}

/** Optional accessor — returns null outside a provider (lets chips fall back to a no-op). */
export function useEntityUiOptional(): EntityUiContextValue | null {
  return useContext(EntityUiContext);
}

/**
 * Hex accent per drawer entity type. Single source of truth for the
 * "accent dust" treatment across header band, avatar tint, badges, and
 * related-entity pill ring.
 */
const ACCENTS: Record<DrawerEntityType, string> = {
  person: "#1e3a8a",
  company: "#b45309",
  product: "#0f766e",
  project: "#6d28d9",
  team: "#475569",
  tool: "#525252",
  system: "#525252",
  other: "#3f3f46",
};

function normalizeType(input: EntityIdentity): DrawerEntityType {
  if (input.entityType) return input.entityType;
  switch (input.sourceType) {
    case "person":
      return "person";
    case "company":
      return "company";
    case "product":
      return "product";
    case "project":
      return "project";
    case "team":
      return "team";
    case "tool":
      return "tool";
    case "clickup_workspace":
    case "clickup_space":
      return "system";
    default:
      return "other";
  }
}

export function entityAccent(entity: EntityIdentity): string {
  return ACCENTS[normalizeType(entity)];
}

function entityInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_SIZES = {
  xs: "h-4 w-4 text-[8px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-12 w-12 text-base",
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZES;

interface EntityAvatarProps {
  entity: EntityIdentity;
  size?: AvatarSize;
  className?: string;
}

export function EntityAvatar({ entity, size = "md", className }: EntityAvatarProps) {
  const accent = entityAccent(entity);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium",
        AVATAR_SIZES[size],
        className,
      )}
      style={{ backgroundColor: `${accent}1a`, color: accent }}
      aria-label={entity.name}
    >
      {entityInitials(entity.name)}
    </span>
  );
}

interface EntityChipProps {
  entity: EntityIdentity;
  /** When true, the chip is a tiny pill (used in dense rows). */
  compact?: boolean;
  /** Override the click handler — default opens drawer for this entity. */
  onClick?: () => void;
  className?: string;
}

export function EntityChip({ entity, compact = false, onClick, className }: EntityChipProps) {
  const accent = entityAccent(entity);
  const ui = useEntityUiOptional();
  const handle = onClick ?? (() => ui?.openEntity(entity.id));
  return (
    <button
      type="button"
      onClick={handle}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border transition hover:bg-muted",
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs",
        className,
      )}
      style={{ borderColor: `${accent}40` }}
    >
      <EntityAvatar entity={entity} size="xs" />
      <span className="truncate font-medium" style={{ color: accent }}>
        {entity.name}
      </span>
    </button>
  );
}
