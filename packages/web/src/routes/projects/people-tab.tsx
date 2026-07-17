/**
 * People tab — the directory, grouped by company with the Unaffiliated tail
 * collapsed by default (315 of 501 people in dev have no `works_at`, so the
 * tail is the common case). Company placement comes from the entity graph's
 * `works_at` edges; people the graph can't place fall into Unaffiliated.
 *
 * Row anatomy follows the prototype: avatar, AI badge, role · internal/external,
 * contact points with source chips (real emails from `metadata.email`, built by
 * {@link contactPointsFromMetadata}; phones/WhatsApp arrive with D1), mentions,
 * last active. Rows render through the shared {@link OrgRow} primitive so their
 * density matches the rest of the surface.
 *
 * Search and the "Needs placement" chip both auto-expand the tail.
 */
import type { EntityListItem } from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar, useEntityUi } from "@/lib/entity-ui";
import { formatRelativeTime } from "@/routes/files/file-list";
import { CaretDownIcon, MagnifyingGlassIcon, SparkleIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContactLine, contactPointsFromMetadata } from "./contact-line";
import { ReviewBandCapped } from "./org-review";
import { OrgRow } from "./org-row";

const PAGE = 200;

interface CompanyInfo {
  id: string;
  name: string;
  subtype: string | null;
}

export function PeopleTab({ onSeeAllReview }: { onSeeAllReview: () => void }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [needsPlacementOnly, setNeedsPlacementOnly] = useState(false);
  const [tailExpanded, setTailExpanded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebounced(search.trim().toLowerCase()), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const peopleQuery = useInfiniteQuery({
    queryKey: ["entities", "person", "org-people"],
    queryFn: ({ pageParam }) => api.entities.list({ type: "person", sort: "mentions", limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.entities.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const companiesQuery = useQuery({
    queryKey: ["entities", "company", "org-people-lookup"],
    queryFn: () => api.entities.list({ type: "company", limit: 200 }),
  });

  const graphQuery = useQuery({
    queryKey: ["entity-graph", "org-people-worksat"],
    queryFn: () => api.entities.graph({ limit: 1000 }),
    staleTime: 5 * 60_000,
  });

  const people = useMemo(() => peopleQuery.data?.pages.flatMap((p) => p.entities) ?? [], [peopleQuery.data]);
  const totalPeople = peopleQuery.data?.pages[0]?.total ?? 0;

  const companiesMap = useMemo(() => {
    const map = new Map<string, CompanyInfo>();
    for (const c of companiesQuery.data?.entities ?? []) map.set(c.id, { id: c.id, name: c.name, subtype: c.subtype });
    return map;
  }, [companiesQuery.data]);

  const personToCompany = useMemo(() => {
    const map = new Map<string, string>();
    const graph = graphQuery.data;
    if (!graph) return map;
    const nodeType = new Map(graph.nodes.map((n) => [n.id, n.sourceType]));
    for (const e of graph.edges) {
      if (e.type !== "works_at") continue;
      const st = nodeType.get(e.source);
      const tt = nodeType.get(e.target);
      if (st === "person" && tt === "company") map.set(e.source, e.target);
      else if (tt === "person" && st === "company") map.set(e.target, e.source);
    }
    return map;
  }, [graphQuery.data]);

  const needsPlacementCount = Math.max(0, totalPeople - personToCompany.size);
  const showTail = tailExpanded || debounced.length > 0 || needsPlacementOnly;

  const filteredPeople = useMemo(() => {
    return people.filter((p) => {
      const hasCompany = personToCompany.has(p.id) && companiesMap.has(personToCompany.get(p.id) as string);
      if (needsPlacementOnly && hasCompany) return false;
      if (debounced) {
        const inName = p.name.toLowerCase().includes(debounced);
        const inAlias = p.aliases.some((a) => a.toLowerCase().includes(debounced));
        if (!inName && !inAlias) return false;
      }
      return true;
    });
  }, [people, personToCompany, companiesMap, needsPlacementOnly, debounced]);

  const { companyGroups, unaffiliated } = useMemo(() => {
    const byCompany = new Map<string, EntityListItem[]>();
    const tail: EntityListItem[] = [];
    for (const p of filteredPeople) {
      const cid = personToCompany.get(p.id);
      if (cid && companiesMap.has(cid)) {
        const bucket = byCompany.get(cid);
        if (bucket) bucket.push(p);
        else byCompany.set(cid, [p]);
      } else {
        tail.push(p);
      }
    }
    const groups = [...byCompany.entries()]
      .map(([cid, members]) => ({ company: companiesMap.get(cid) as CompanyInfo, members }))
      .sort((a, b) => b.members.length - a.members.length);
    return { companyGroups: groups, unaffiliated: tail };
  }, [filteredPeople, personToCompany, companiesMap]);

  const loading = peopleQuery.isLoading;

  return (
    <div className="space-y-4">
      <ReviewBandCapped types={["person"]} onSeeAll={onSeeAllReview} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder="Search people…"
            className="pl-9 text-sm"
          />
        </div>
        {needsPlacementCount > 0 ? (
          <button
            type="button"
            onClick={() => setNeedsPlacementOnly((v) => !v)}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors",
              needsPlacementOnly
                ? "border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-300"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            ⚑ Needs placement · {needsPlacementCount}
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((k) => (
            <Skeleton key={k} className="h-11 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border" data-testid="org-people-table">
          <div className="flex items-center gap-2.5 border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <span className="min-w-0 flex-1">Name</span>
            <span className="hidden w-56 sm:block">Contact</span>
            <span className="w-14 text-center">Mentions</span>
            <span className="w-16 text-right">Active</span>
          </div>

          {!needsPlacementOnly &&
            companyGroups.map((group) => (
              <div key={group.company.id}>
                <GroupHeader name={group.company.name} subtype={group.company.subtype} count={group.members.length} />
                {group.members.map((person) => (
                  <PersonRow key={person.id} person={person} />
                ))}
              </div>
            ))}

          {unaffiliated.length > 0 || needsPlacementOnly ? (
            <div>
              <button
                type="button"
                onClick={() => setTailExpanded((v) => !v)}
                className="flex w-full items-center justify-between border-b border-border bg-muted/20 px-3 py-2 text-left"
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                  Unaffiliated · {needsPlacementOnly ? unaffiliated.length : needsPlacementCount}
                </span>
                <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
                  {showTail ? "Hide" : "Show"}
                  <CaretDownIcon size={11} className={cn("transition-transform", !showTail && "-rotate-90")} />
                </span>
              </button>
              {showTail ? unaffiliated.map((person) => <PersonRow key={person.id} person={person} />) : null}
              {showTail && peopleQuery.hasNextPage ? (
                <button
                  type="button"
                  onClick={() => peopleQuery.fetchNextPage()}
                  disabled={peopleQuery.isFetchingNextPage}
                  className="w-full border-t border-border px-3 py-2.5 text-center text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                >
                  {peopleQuery.isFetchingNextPage ? "Loading…" : "Load more people"}
                </button>
              ) : null}
            </div>
          ) : null}

          {filteredPeople.length === 0 ? (
            <p className="px-3 py-10 text-center text-[12.5px] text-muted-foreground">
              {debounced ? "No people match your search." : "No people yet."}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GroupHeader({ name, subtype, count }: { name: string; subtype: string | null; count: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/10 px-3 py-1.5">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-foreground/80">{name}</span>
      {subtype ? (
        <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-muted-foreground">
          {subtype}
        </Badge>
      ) : null}
      <span className="font-mono text-[10px] text-muted-foreground/70">· {count}</span>
    </div>
  );
}

function PersonRow({ person }: { person: EntityListItem }) {
  const { openEntity } = useEntityUi();
  const meta = person.metadata ?? {};
  const isAi = meta.origin === "ai";
  const role = (meta.role ?? meta.title ?? null) as string | null;
  const subtype = person.subtype === "internal" ? "Internal" : person.subtype === "external" ? "External" : null;
  const subtitle = [role, subtype].filter(Boolean).join(" · ") || null;
  const contacts = contactPointsFromMetadata(person.metadata);

  return (
    <OrgRow
      testId={`org-person-${person.id}`}
      onOpen={() => openEntity(person.id)}
      avatar={<EntityAvatar entity={{ id: person.id, name: person.name, sourceType: "person" }} size="sm" />}
      primary={person.name}
      primaryChips={
        isAi ? (
          <Badge
            variant="secondary"
            className="gap-0.5 bg-violet-100 px-1 py-0 text-[9px] text-violet-700 dark:bg-violet-900 dark:text-violet-300"
          >
            <SparkleIcon size={8} weight="fill" />
            AI
          </Badge>
        ) : null
      }
      secondary={subtitle}
      middle={
        <div className="hidden w-56 flex-col gap-0.5 sm:flex">
          {contacts.length === 0 ? (
            <span className="text-[11px] text-muted-foreground/50">No contact points</span>
          ) : (
            contacts.map((c) => <ContactLine key={`${c.kind}-${c.value}`} contact={c} />)
          )}
        </div>
      }
      meta={
        <>
          <span className="w-14 text-center font-mono text-xs text-muted-foreground">
            {person.mentionCount > 0 ? person.mentionCount : "-"}
          </span>
          <span className="w-16 text-right text-xs text-muted-foreground">
            {person.lastMentionAt ? formatRelativeTime(person.lastMentionAt) : "-"}
          </span>
        </>
      }
    />
  );
}
