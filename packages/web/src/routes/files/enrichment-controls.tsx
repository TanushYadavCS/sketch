import { api } from "@/lib/api";
import { ArrowSquareOutIcon, EyeIcon, EyeSlashIcon, SpinnerGapIcon } from "@phosphor-icons/react";
/**
 * SearchSettingsSheet — slide-over dialog for configuring AI enrichment
 * and the Gemini API key. Accessible via the gear icon in the page header.
 */
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Switch } from "@sketch/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function SearchSettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["settings", "search"],
    queryFn: () => api.settings.searchConfig(),
    enabled: open,
  });

  const [geminiKey, setGeminiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRunPrompt, setShowRunPrompt] = useState(false);

  useEffect(() => {
    if (data) {
      setGeminiKey("");
      setKeyConfigured(data.geminiApiKeyConfigured);
      setEnrichmentEnabled(data.enrichmentEnabled === 1);
      setDirty(false);
      setShowRunPrompt(false);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (updates: { geminiApiKey?: string | null; enrichmentEnabled?: boolean }) =>
      api.settings.updateSearchConfig(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "search"] });
      setDirty(false);
      if (enrichmentEnabled) {
        setShowRunPrompt(true);
      } else {
        toast.success("Settings saved");
        onOpenChange(false);
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const enrichMutation = useMutation({
    mutationFn: () => api.settings.runEnrichment(),
    onSuccess: () => {
      toast.success("Enrichment started — files will be processed in the background.");
      onOpenChange(false);
      setShowRunPrompt(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleSave() {
    const updates: { geminiApiKey?: string | null; enrichmentEnabled?: boolean } = {};
    if (geminiKey.trim()) updates.geminiApiKey = geminiKey;
    if (enrichmentEnabled !== (data?.enrichmentEnabled === 1)) updates.enrichmentEnabled = enrichmentEnabled;
    mutation.mutate(updates);
  }

  const needsKey = enrichmentEnabled && !keyConfigured && !geminiKey.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setShowRunPrompt(false);
        onOpenChange(v);
      }}
    >
      <DialogContent>
        {showRunPrompt ? (
          <>
            <DialogHeader>
              <DialogTitle>Run enrichment now?</DialogTitle>
              <DialogDescription>
                This will tag, summarize, and generate embeddings for all pending files. You can also run it later from
                individual files.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  toast.success("Settings saved");
                  onOpenChange(false);
                  setShowRunPrompt(false);
                }}
              >
                Not now
              </Button>
              <Button onClick={() => enrichMutation.mutate()} disabled={enrichMutation.isPending}>
                {enrichMutation.isPending && <SpinnerGapIcon size={16} className="mr-2 animate-spin" />}
                Run enrichment
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Search & Enrichment</DialogTitle>
              <DialogDescription>Configure how files are indexed and searched.</DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="enrichment-toggle" className="text-sm font-medium">
                  AI Enrichment
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {enrichmentEnabled
                    ? "Files are tagged, summarized & embedded for semantic search"
                    : "Search uses keyword matching only (FTS5)"}
                </p>
              </div>
              <Switch
                id="enrichment-toggle"
                checked={enrichmentEnabled}
                onCheckedChange={(checked) => {
                  setEnrichmentEnabled(checked);
                  setDirty(true);
                }}
              />
            </div>

            {enrichmentEnabled && (
              <>
                <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
                  <li>Go to Google AI Studio</li>
                  <li>Create or select a project</li>
                  <li>Generate an API key</li>
                  <li>Paste it below</li>
                </ol>

                <Button variant="ghost" size="sm" asChild className="w-fit">
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
                    Get API key
                    <ArrowSquareOutIcon className="size-3.5" />
                  </a>
                </Button>

                <div className="space-y-1.5">
                  <Label htmlFor="gemini-key" className="text-xs">
                    Gemini API Key
                  </Label>
                  <div className="relative">
                    <Input
                      id="gemini-key"
                      type={showKey ? "text" : "password"}
                      value={geminiKey}
                      onChange={(e) => {
                        setGeminiKey(e.target.value);
                        setDirty(true);
                      }}
                      placeholder={keyConfigured ? "Key configured (enter new to replace)" : "AIza..."}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">Used for generating vector embeddings</p>
                </div>
              </>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!dirty || mutation.isPending || needsKey}>
                {mutation.isPending && <SpinnerGapIcon size={16} className="mr-2 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
