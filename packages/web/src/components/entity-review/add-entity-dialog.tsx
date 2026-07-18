/**
 * Shared "Add entity" dialog. One control creates any taxonomy entity; the
 * type picker defaults to whatever the host surface emphasises (Your Org
 * defaults to `product`, the Files explorer to `company`).
 *
 * Products route through the declare path (`api.products.create`) so declaring
 * one that already exists as an inferred guess upgrades it in place instead of
 * creating a duplicate; every other type uses the generic entity create. Both
 * paths land the row at `provenance_tier = declared` (a human assertion).
 */
import { api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  const [name, setName] = useState("");
  const [type, setType] = useState(defaultType);

  const createMutation = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (type === "product") {
        await api.products.create({ name: trimmed });
      } else {
        await api.entities.create({ name: trimmed, sourceType: type });
      }
    },
    onSuccess: () => {
      toast.success(`Entity "${name.trim()}" created.`);
      onOpenChange(false);
      setName("");
      setType(defaultType);
      queryClient.invalidateQueries({ queryKey: ["entities"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
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
        <div className="space-y-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</p>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              className="mt-1 text-sm"
              placeholder="e.g. CanvasX, Epik, Product Alpha"
            />
          </div>
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
