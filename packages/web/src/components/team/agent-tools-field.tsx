/**
 * AgentToolsField — checkbox list of canonical tools an agent can be granted.
 * Persists canonical names (e.g. "Read", "mcp__sketch__SendFileToChat") and
 * shows friendly labels. Empty selection means the agent can use no tools.
 */
import { AGENT_TOOL_CATALOG, type AgentToolCatalogEntry } from "@sketch/shared";
import { Button } from "@sketch/ui/components/button";
import { Label } from "@sketch/ui/components/label";

const CATEGORY_LABELS: Record<AgentToolCatalogEntry["category"], string> = {
  builtin: "Built-in tools",
  sketch: "Sketch tools",
};

const ENTRIES_BY_CATEGORY = AGENT_TOOL_CATALOG.reduce<Record<string, AgentToolCatalogEntry[]>>((acc, entry) => {
  if (!acc[entry.category]) acc[entry.category] = [];
  acc[entry.category].push(entry);
  return acc;
}, {});

const ALL_TOOL_NAMES = AGENT_TOOL_CATALOG.map((entry) => entry.name);

export function AgentToolsField({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const selected = new Set(value);
  const allSelected = ALL_TOOL_NAMES.every((name) => selected.has(name));

  const toggle = (name: string) => {
    if (selected.has(name)) {
      onChange(value.filter((n) => n !== name));
    } else {
      onChange([...value, name]);
    }
  };

  const selectAll = () => onChange([...ALL_TOOL_NAMES]);
  const clearAll = () => onChange([]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Tools</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={selectAll}
            disabled={disabled || allSelected}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={clearAll}
            disabled={disabled || value.length === 0}
          >
            Clear
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Choose which tools this agent can use. An agent with no tools selected can only reply with text.
      </p>
      <div className="space-y-3 rounded-md border border-border p-3">
        {(Object.entries(ENTRIES_BY_CATEGORY) as [AgentToolCatalogEntry["category"], AgentToolCatalogEntry[]][]).map(
          ([category, entries]) => (
            <div key={category} className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABELS[category]}
              </p>
              <div className="space-y-1.5">
                {entries.map((entry) => {
                  const id = `agent-tool-${entry.name}`;
                  return (
                    <label
                      key={entry.name}
                      htmlFor={id}
                      className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                    >
                      <input
                        id={id}
                        type="checkbox"
                        checked={selected.has(entry.name)}
                        onChange={() => toggle(entry.name)}
                        disabled={disabled}
                        className="mt-0.5 size-4 rounded border-border"
                      />
                      <div className="space-y-0.5">
                        <div className="text-sm font-medium leading-none">{entry.label}</div>
                        <div className="text-xs text-muted-foreground">{entry.description}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
