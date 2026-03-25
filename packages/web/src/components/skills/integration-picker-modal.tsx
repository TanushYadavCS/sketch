import { CheckIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { useMemo, useState } from "react";

interface IntegrationOption {
  id: string;
  name: string;
  description: string;
  connectionType: "oauth" | "api_key";
  iconBg: string;
  iconLetter: string;
}

interface IntegrationPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allIntegrations: IntegrationOption[];
  addedIds: Set<string>;
  onAdd: (id: string) => void;
}

export function IntegrationPickerModal({
  open,
  onOpenChange,
  allIntegrations,
  addedIds,
  onAdd,
}: IntegrationPickerModalProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return allIntegrations;
    const q = search.toLowerCase();
    return allIntegrations.filter((i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  }, [search, allIntegrations]);

  const handleAdd = (id: string) => {
    onAdd(id);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setSearch("");
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="text-base font-semibold">Add integration</DialogTitle>
        </DialogHeader>

        <div className="border-b px-6 py-3">
          <div className="relative">
            <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search integrations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <XIcon size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[400px] overflow-y-auto">
          <div className="px-6 py-2">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <MagnifyingGlassIcon size={32} className="mb-3 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No integrations found</p>
                <p className="mt-1 text-xs text-muted-foreground">Try a different search term</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map((integration) => {
                  const isAdded = addedIds.has(integration.id);
                  return (
                    <div
                      key={integration.id}
                      role={!isAdded ? "button" : undefined}
                      tabIndex={!isAdded ? 0 : undefined}
                      className={`flex items-center gap-3 py-3 ${
                        isAdded
                          ? "opacity-60"
                          : "cursor-pointer rounded-md px-2 -mx-2 transition-colors hover:bg-muted/50"
                      }`}
                      onClick={() => {
                        if (!isAdded) handleAdd(integration.id);
                      }}
                      onKeyDown={(e) => {
                        if (!isAdded && (e.key === "Enter" || e.key === " ")) handleAdd(integration.id);
                      }}
                    >
                      <div
                        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${integration.iconBg} text-sm font-semibold text-white`}
                      >
                        {integration.iconLetter}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{integration.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{integration.description}</p>
                      </div>
                      {isAdded && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CheckIcon size={14} />
                          Added
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
