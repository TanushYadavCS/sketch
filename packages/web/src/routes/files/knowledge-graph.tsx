/**
 * Knowledge graph — the whole org brain on an immersive dark stage.
 *
 * Renders the entire entity graph (`api.entities.graph`), force-laid-out on a
 * dark, glowing canvas in the spirit of the usage tab's visual language (brand
 * yellow accents, near-black surfaces, thin borders, mono labels). Nodes glow,
 * hubs are sized by connectivity, and hovering a node lights up its
 * neighbourhood and dims the rest (Obsidian-style focus). Tap a node to open
 * the existing entity drawer (summary · timeline · relationships) — the brief.
 */
import { api } from "@/lib/api";
import { useEntityUiOptional } from "@/lib/entity-ui";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";

export type CoarseType = "person" | "company" | "project" | "product" | "team" | "tool" | "system" | "other";

function coarseType(sourceType: string): CoarseType {
  if (sourceType === "person") return "person";
  if (sourceType === "company") return "company";
  if (sourceType === "product") return "product";
  if (sourceType === "project" || sourceType === "linear_project") return "project";
  if (sourceType === "team") return "team";
  if (sourceType === "tool") return "tool";
  if (sourceType.startsWith("clickup_") || sourceType.startsWith("notion_")) return "system";
  return "other";
}

/** Brighter, saturated palette tuned for the dark stage (the muted drawer accents read flat here). */
const NODE_COLOR: Record<CoarseType, string> = {
  person: "#6ea8fe",
  company: "#f6ad3c",
  project: "#b794f6",
  product: "#2dd4bf",
  team: "#9aa7b8",
  tool: "#8b8f96",
  system: "#8b8f96",
  other: "#a8a29e",
};

const ACCENT = "#FEED01";

const TYPE_LABEL: Record<CoarseType, string> = {
  person: "People",
  company: "Companies",
  project: "Projects",
  product: "Products",
  team: "Teams",
  tool: "Tools",
  system: "Spaces",
  other: "Other",
};

const LEGEND: CoarseType[] = ["person", "company", "project", "product", "team"];

interface GraphNode extends NodeObject {
  id: string;
  name: string;
  type: CoarseType;
  color: string;
  val: number;
}

function endpointId(end: string | number | NodeObject | undefined): string {
  if (end && typeof end === "object") return String((end as GraphNode).id);
  return String(end);
}

/**
 * @param focusType when set, the graph is restricted to nodes of that coarse
 *   type plus their direct neighbours — the Your Org tab strip drives this so
 *   the active tab focuses the graph. `null`/undefined shows the full graph.
 */
export function KnowledgeGraphView({ focusType = null }: { focusType?: CoarseType | null } = {}) {
  const ui = useEntityUiOptional();
  const [containerRef, size] = useSize();
  const fgRef = useRef<ForceGraphMethods<GraphNode> | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["entity-graph"],
    queryFn: () => api.entities.graph({ limit: 600 }),
    staleTime: 5 * 60_000,
  });

  const { nodes, links, adjacency } = useMemo(() => {
    if (!data) {
      return {
        nodes: [] as GraphNode[],
        links: [] as { source: string; target: string }[],
        adjacency: new Map<string, Set<string>>(),
      };
    }
    // Focus filter: keep nodes of the active tab's type plus their direct
    // neighbours, and edges between kept nodes. Keeps `works_at`-style edges
    // meaningful (a person filter still shows their companies).
    let focusNodes = data.nodes;
    let focusEdges = data.edges;
    if (focusType) {
      const nodeType = new Map(data.nodes.map((n) => [n.id, coarseType(n.sourceType)]));
      const keepIds = new Set<string>();
      for (const n of data.nodes) if (nodeType.get(n.id) === focusType) keepIds.add(n.id);
      for (const e of data.edges) {
        if (nodeType.get(e.source) === focusType) keepIds.add(e.target);
        if (nodeType.get(e.target) === focusType) keepIds.add(e.source);
      }
      focusNodes = data.nodes.filter((n) => keepIds.has(n.id));
      focusEdges = data.edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));
    }

    const degree = new Map<string, number>();
    const seen = new Set<string>();
    const allLinks: { source: string; target: string }[] = [];
    for (const e of focusEdges) {
      if (e.source === e.target) continue;
      const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allLinks.push({ source: e.source, target: e.target });
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    // Keep only sizeable connected components so stray 2-node threads don't scatter.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root) ?? root;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur) ?? root;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    for (const id of degree.keys()) parent.set(id, id);
    for (const l of allLinks) {
      const a = find(l.source);
      const b = find(l.target);
      if (a !== b) parent.set(a, b);
    }
    // Keep only the largest connected component — the org brain — so the canvas
    // is one centred constellation instead of a main mass plus drifting satellites.
    const compSize = new Map<string, number>();
    for (const id of degree.keys()) compSize.set(find(id), (compSize.get(find(id)) ?? 0) + 1);
    let biggestRoot = "";
    let biggest = 0;
    for (const [root, n] of compSize) {
      if (n > biggest) {
        biggest = n;
        biggestRoot = root;
      }
    }
    // When focused, keep every connected node in the focus set; otherwise trim
    // to the single largest component so the full graph reads as one constellation.
    const keep = focusType ? () => true : (id: string) => find(id) === biggestRoot;

    const keptLinks = allLinks.filter((l) => keep(l.source) && keep(l.target));
    const adj = new Map<string, Set<string>>();
    for (const l of keptLinks) {
      (adj.get(l.source) ?? adj.set(l.source, new Set()).get(l.source))?.add(l.target);
      (adj.get(l.target) ?? adj.set(l.target, new Set()).get(l.target))?.add(l.source);
    }
    const keptNodes = focusNodes
      .filter((n) => degree.has(n.id) && keep(n.id))
      .map((n) => {
        const type = coarseType(n.sourceType);
        return { id: n.id, name: n.name, type, color: NODE_COLOR[type], val: 1 + (degree.get(n.id) ?? 0) };
      });
    return { nodes: keptNodes, links: keptLinks, adjacency: adj };
  }, [data, focusType]);

  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  const query = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!query) return null;
    const set = new Set<string>();
    for (const n of nodes) if (n.name.toLowerCase().includes(query)) set.add(n.id);
    return set;
  }, [query, nodes]);

  // The set in focus: search matches > hovered node + neighbours > everything.
  const focusSet = useMemo(() => {
    if (matches) return matches;
    if (hoveredId) {
      const set = new Set<string>([hoveredId]);
      for (const nb of adjacency.get(hoveredId) ?? []) set.add(nb);
      return set;
    }
    return null;
  }, [matches, hoveredId, adjacency]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the node set or canvas first appears.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || nodes.length === 0) return;
    fg.d3Force("charge")?.strength(-140);
    fg.d3Force("link")?.distance(34);
    const t = setTimeout(() => fg.zoomToFit(700, 60), 1200);
    return () => clearTimeout(t);
  }, [nodes.length, size.w]);

  const drawNode = useCallback(
    (node: NodeObject<GraphNode>, ctx: CanvasRenderingContext2D, scale: number) => {
      const n = node as GraphNode;
      const r = Math.sqrt(n.val) * 1.7 + 1.6;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const isSel = n.id === selectedId;
      const isHover = n.id === hoveredId;
      const dimmed = focusSet ? !focusSet.has(n.id) : false;
      const isHub = n.val >= 9;

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.1 : 1;
      // Soft halo on hubs / focused / selected nodes.
      const glow = isSel || isHover ? 18 : isHub && !dimmed ? 12 : 0;
      if (glow > 0) {
        ctx.shadowBlur = glow;
        ctx.shadowColor = isSel ? ACCENT : n.color;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.restore();

      if (isSel) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.6 / scale;
        ctx.stroke();
      }

      const showLabel = isSel || isHover || matches?.has(n.id) || isHub || scale > 4;
      if (showLabel && !dimmed) {
        const fontSize = Math.min(13, 10 / scale + 2.5);
        ctx.font = `${isHub || isSel ? 600 : 400} ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.shadowBlur = 6;
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.fillStyle = isSel || isHover ? "#fff" : "rgba(255,255,255,0.82)";
        ctx.fillText(n.name, x, y + r + 2 / scale);
        ctx.shadowBlur = 0;
      }
    },
    [selectedId, hoveredId, focusSet, matches],
  );

  const linkColor = useCallback(
    (link: LinkObject<GraphNode>) => {
      if (focusSet) {
        const s = endpointId(link.source);
        const t = endpointId(link.target);
        const touches = focusSet.has(s) && focusSet.has(t);
        if (hoveredId) return touches ? "rgba(254,237,1,0.45)" : "rgba(255,255,255,0.04)";
        return touches ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.03)";
      }
      return "rgba(255,255,255,0.08)";
    },
    [focusSet, hoveredId],
  );

  return (
    <div className="relative mt-3 h-[76vh] overflow-hidden rounded-xl border border-black/30 bg-[#0b0b0a] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      {/* dot grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.045) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
        aria-hidden
      />
      {/* warm centre glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(ellipse 60% 55% at 50% 42%, rgba(254,237,1,0.07), transparent 70%)" }}
        aria-hidden
      />

      <div ref={containerRef} className="relative h-full w-full">
        {/* Toolbar */}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
          <div className="relative">
            <MagnifyingGlassIcon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the graph…"
              className="w-56 rounded-full border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-xs text-white shadow-sm outline-none backdrop-blur placeholder:text-white/35 focus:border-[#FEED01]/40"
            />
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-white/55 shadow-sm backdrop-blur">
            {nodes.length} entities · {links.length} links
          </span>
        </div>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 shadow-sm backdrop-blur">
          {LEGEND.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.05em] text-white/55"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: NODE_COLOR[t], boxShadow: `0 0 6px ${NODE_COLOR[t]}` }}
                aria-hidden
              />
              {TYPE_LABEL[t]}
            </span>
          ))}
        </div>

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/50">
            Loading the org brain…
          </div>
        )}

        {size.w > 0 && size.h > 0 && (
          <ForceGraph2D
            ref={fgRef}
            width={size.w}
            height={size.h}
            graphData={graphData}
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={3}
            nodeVal={(n) => (n as GraphNode).val}
            nodeLabel={() => ""}
            nodeColor={(n) => (n as GraphNode).color}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={(node, color, ctx) => {
              const n = node as GraphNode;
              const r = Math.sqrt(n.val) * 1.7 + 4;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
              ctx.fill();
            }}
            linkColor={linkColor}
            linkWidth={(l) => {
              if (!hoveredId) return 0.6;
              const touches = focusSet?.has(endpointId(l.source)) && focusSet?.has(endpointId(l.target));
              return touches ? 1.2 : 0.4;
            }}
            onNodeClick={(n) => {
              const g = n as GraphNode;
              setSelectedId(g.id);
              ui?.openEntity(g.id);
            }}
            onNodeHover={(n) => setHoveredId(n ? (n as GraphNode).id : null)}
            onBackgroundClick={() => setSelectedId(null)}
            cooldownTicks={140}
            d3VelocityDecay={0.35}
            warmupTicks={40}
          />
        )}
      </div>
    </div>
  );
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        Math.round(prev.w) === Math.round(rect.width) && Math.round(prev.h) === Math.round(rect.height)
          ? prev
          : { w: rect.width, h: rect.height },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return [ref, size] as const;
}
