/**
 * Shared "Add entity" dialog. One control creates any taxonomy entity; the
 * type picker defaults to whatever the host surface emphasises (Your Org
 * defaults to `product`, the Files explorer to `company`).
 *
 * Products route through the declare path (`api.products.create`) so declaring
 * one that already exists as an inferred guess upgrades it in place instead of
 * creating a duplicate; every other type uses the generic entity create. Both
 * paths land the row at `provenance_tier = declared` (a human assertion).
 *
 * Creation is idempotent only on the exact name, so as the name and aliases
 * are typed the dialog surfaces close existing entities (the list endpoint
 * matches names and aliases) with an "Open existing" escape hatch — the
 * guardrail against minting "One Stop" next to an existing "One Stop AI".
 * On create the new entity opens in the drawer so type-specific enrichment
 * (contacts, people) continues there.
 */
import { api } from "@/lib/api";
import type { EntityListItem } from "@/lib/api";
import { useEntityUiOptional } from "@/lib/entity-ui";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const ENTITY_TYPES = ["product", "company", "client", "project", "team", "person"] as const;

export function AddEntityDialog({
  open,
  onOpenChange,
  defaultType = "company",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: string;
}) {
  const queryClient = useQueryClient();
  const entityUi = useEntityUiOptional();
  const [name, setName] = useState("");
  const [type, setType] = useState(defaultType);
  const [aliasesInput, setAliasesInput] = useState("");
  const [debouncedTerms, setDebouncedTerms] = useState<string[]>([]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const terms = [name, ...aliasesInput.split(",")].map((term) => term.trim()).filter((term) => term.length >= 2);
      setDebouncedTerms([...new Set(terms)]);
    }, 150);
    return () => clearTimeout(handle);
  }, [name, aliasesInput]);

  const similarQuery = useQuery({
    queryKey: ["add-entity", "similar", debouncedTerms],
    queryFn: async () => {
      const results = await Promise.all(debouncedTerms.map((term) => api.entities.list({ search: term, limit: 5 })));
      const byId = new Map<string, EntityListItem>();
      for (const result of results) {
        for (const entity of result.entities) byId.set(entity.id, entity);
      }
      return [...byId.values()].slice(0, 5);
    },
    enabled: open && debouncedTerms.length > 0,
  });
  const similar = debouncedTerms.length > 0 ? (similarQuery.data ?? []) : [];

  const openExisting = (entity: EntityListItem) => {
    onOpenChange(false);
    entityUi?.openEntity(entity.id);
  };

  const createMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      const trimmed = name.trim();
      if (type === "product") {
        const res = await api.products.create({ name: trimmed });
        return res.entity.id;
      }
      const aliases = aliasesInput
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      const res = await api.entities.create({
        name: trimmed,
        sourceType: type,
        ...(aliases.length > 0 ? { aliases } : {}),
      });
      return res.entity.id;
    },
    onSuccess: (entityId) => {
      toast.success(`Entity "${name.trim()}" created.`);
      onOpenChange(false);
      setName("");
      setAliasesInput("");
      setType(defaultType);
      queryClient.invalidateQueries({ queryKey: ["entities"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      entityUi?.openEntity(entityId);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add entity</DialogTitle>
          <DialogDescription>Declare an entity that Sketch should already know about.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</p>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              className="mt-1 text-sm"
              placeholder="e.g. CanvasX, Epik, Product Alpha"
            />
          </div>
          {similar.length > 0 ? (
            <div className="rounded-md border border-amber-300/50 bg-amber-50/40 p-2 dark:bg-amber-950/20">
              <p className="text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-500">
                Similar existing entities
              </p>
              <div className="mt-1 flex flex-col">
                {similar.map((entity) => (
                  <div key={entity.id} className="flex min-w-0 items-center gap-2 py-1">
                    <span className="min-w-0 truncate text-xs font-medium">{entity.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{entity.sourceType}</span>
                    {entity.aliases.length > 0 ? (
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {entity.aliases.join(", ")}
                      </span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 shrink-0 px-2 text-[11px]"
                      onClick={() => openExisting(entity)}
                    >
                      Open existing
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Type</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ENTITY_TYPES.map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={type === t ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => setType(t)}
                >
                  {t}
                </Button>
              ))}
            </div>
          </div>
          {type !== "product" ? (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Aliases <span className="normal-case tracking-normal">(optional, comma-separated)</span>
              </p>
              <Input
                value={aliasesInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAliasesInput(e.target.value)}
                className="mt-1 text-sm"
                placeholder="e.g. One Stop, OSAI"
              />
            </div>
          ) : null}
          <Button
            className="w-full text-xs"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !name.trim()}
          >
            {createMutation.isPending ? "Creating..." : "Create entity"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
