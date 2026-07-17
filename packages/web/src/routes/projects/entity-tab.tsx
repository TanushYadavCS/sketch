/**
 * Per-type entity tabs for the Your Org surface. Each mounts the Entity
 * Explorer table ({@link EntityTable}) filtered to one taxonomy type, opened by
 * a type-scoped capped review band. Companies / Teams / Projects use the
 * generic {@link OrgEntityTab}; Products has its own two-section split.
 */
import { api } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
import { EntityTable } from "@/routes/files/entity-explorer";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ReviewBandCapped } from "./org-review";

function useDebouncedSearch(delay = 300) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const ref = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => setDebounced(search.trim()), delay);
    return () => {
      if (ref.current) clearTimeout(ref.current);
    };
  }, [search, delay]);
  return { search, setSearch, debounced };
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9 text-sm"
      />
    </div>
  );
}

function useEntityList(type: string, search: string) {
  return useQuery({
    queryKey: ["entities", type, search],
    queryFn: () => api.entities.list({ type, search: search || undefined, sort: "hotness", limit: 200 }),
    refetchInterval: 30000,
  });
}

export function OrgEntityTab({
  type,
  typeLabel,
  onSeeAllReview,
  renderEmpty,
}: {
  type: string;
  typeLabel: string;
  onSeeAllReview: () => void;
  renderEmpty?: (search: string) => ReactNode;
}) {
  const { search, setSearch, debounced } = useDebouncedSearch();
  const { openEntity } = useEntityUi();
  const { data, isLoading } = useEntityList(type, debounced);
  const entities = data?.entities ?? [];

  return (
    <div className="space-y-4">
      <ReviewBandCapped types={[type]} onSeeAll={onSeeAllReview} />
      <SearchInput value={search} onChange={setSearch} placeholder={`Search ${typeLabel.toLowerCase()}…`} />
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((k) => (
            <Skeleton key={k} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : entities.length === 0 ? (
        renderEmpty ? (
          renderEmpty(debounced)
        ) : (
          <OrgEmpty>
            {debounced ? `No ${typeLabel.toLowerCase()} match your search.` : `No ${typeLabel.toLowerCase()} yet.`}
          </OrgEmpty>
        )
      ) : (
        <EntityTable entities={entities} onSelect={openEntity} />
      )}
    </div>
  );
}

export function ProductsTab({
  onSeeAllReview,
  onDeclare,
}: {
  onSeeAllReview: () => void;
  onDeclare: () => void;
}) {
  const { openEntity } = useEntityUi();
  const ours = useEntityList("product", "");
  const tools = useEntityList("tool", "");
  const products = ours.data?.entities ?? [];
  const toolEntities = tools.data?.entities ?? [];

  return (
    <div className="space-y-4">
      <ReviewBandCapped types={["product"]} onSeeAll={onSeeAllReview} />

      <section>
        <SectionLabel label="Ours" note={`${products.length} declared`} accent />
        {ours.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : products.length === 0 ? (
          <OrgEmpty>
            <span>No products yet.</span>{" "}
            <button type="button" onClick={onDeclare} className="font-medium text-foreground underline-offset-2 hover:underline">
              + Declare a product
            </button>
          </OrgEmpty>
        ) : (
          <EntityTable entities={products} onSelect={openEntity} />
        )}
      </section>

      <section>
        <SectionLabel label="Tools we use" note={toolEntities.length > 0 ? `${toolEntities.length} tracked` : "coming soon"} />
        {tools.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : toolEntities.length === 0 ? (
          <OrgEmpty>
            The tools your org runs on — split out from products — appear here once tool classification ships.
          </OrgEmpty>
        ) : (
          <EntityTable entities={toolEntities} onSelect={openEntity} />
        )}
      </section>
    </div>
  );
}

function SectionLabel({ label, note, accent }: { label: string; note: string; accent?: boolean }) {
  return (
    <div className="mb-3 flex items-baseline justify-between border-b border-border/60 pb-2">
      <span
        className={[
          "font-mono text-[11px] uppercase tracking-[0.12em]",
          accent ? "text-[#8B7A00] dark:text-brand-accent" : "text-muted-foreground",
        ].join(" ")}
      >
        {label}
      </span>
      <span className="font-mono text-[10px] tracking-[0.04em] text-muted-foreground/70">{note}</span>
    </div>
  );
}

export function OrgEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border py-10 text-center text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}

/** Teach empty state for the Teams tab — points at the review queue. */
export function TeamsEmpty({ pendingCount, onSeeAllReview }: { pendingCount: number; onSeeAllReview: () => void }) {
  return (
    <OrgEmpty>
      Teams appear from Linear &amp; ClickUp
      {pendingCount > 0 ? (
        <>
          {" — "}
          <button
            type="button"
            onClick={onSeeAllReview}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {pendingCount} waiting in Review →
          </button>
        </>
      ) : (
        "."
      )}
    </OrgEmpty>
  );
}
