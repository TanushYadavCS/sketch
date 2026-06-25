import { CalendarDotsIcon, type IconProps, PuzzlePieceIcon, SparkleIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";

export interface TileDef {
  title: string;
  primary: string;
  secondary: string;
  icon: ComponentType<IconProps>;
  href?: string;
  onClick?: () => void;
}

export const DEFAULT_TILES: TileDef[] = [
  {
    title: "Automations",
    primary: "Scheduled tasks",
    secondary: "View and manage recurring work",
    icon: CalendarDotsIcon,
    href: "/scheduled-tasks",
  },
  {
    title: "Skills",
    primary: "Skill library",
    secondary: "Create and manage agent abilities",
    icon: SparkleIcon,
    href: "/skills",
  },
  {
    title: "Integrations",
    primary: "Connected apps",
    secondary: "Manage apps and data sources",
    icon: PuzzlePieceIcon,
    href: "/integrations",
  },
  {
    title: "Team",
    primary: "Team members",
    secondary: "Invite users and manage access",
    icon: UsersThreeIcon,
    href: "/team",
  },
];

export function getDefaultTiles(): TileDef[] {
  return DEFAULT_TILES;
}

export interface TileGridProps {
  tiles?: TileDef[];
  className?: string;
}

export function TileGrid({ tiles = DEFAULT_TILES, className }: TileGridProps) {
  return (
    <div
      className={cn("grid w-full gap-[12px]", className)}
      style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
    >
      {tiles.map((tile) => (
        <TileItem key={tile.title} tile={tile} />
      ))}
    </div>
  );
}

function TileItem({ tile }: { tile: TileDef }) {
  const Icon = tile.icon;
  const Inner = (
    <>
      <div className="flex items-center gap-[8px]">
        <Icon size={16} weight="regular" aria-hidden className="shrink-0 text-[#412402] dark:text-[#FEED01]" />
        <span className="text-[12px] font-medium text-muted-foreground">{tile.title}</span>
      </div>
      <div className="mt-[10px] flex flex-col">
        <span className="text-[18px] font-semibold leading-[1.25] text-foreground">{tile.primary}</span>
        <span className="mt-[4px] text-[12px] leading-[1.45] text-muted-foreground">{tile.secondary}</span>
      </div>
    </>
  );

  const baseClass = cn(
    "group relative flex flex-col overflow-hidden rounded-[8px] bg-card border border-border",
    "transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out cursor-pointer text-left",
    "hover:bg-muted/40 hover:border-foreground/20",
    "hover:-translate-y-[0.5px] hover:shadow-[0_2px_6px_-2px_rgba(0,0,0,0.06)]",
    "active:translate-y-0 active:shadow-none",
    "px-[16px] py-[14px]",
  );

  if (tile.href) {
    return (
      <Link to={tile.href} className={baseClass}>
        {Inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={tile.onClick} className={baseClass}>
      {Inner}
    </button>
  );
}
