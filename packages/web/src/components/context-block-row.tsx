/**
 * One block of context handed to a model, stated so a reader can judge it.
 *
 * The row's job is the three facts a raw prompt cannot show: the rule that
 * selected the items, how many the rule matched *before* any cap, and how many
 * actually went. `total > items.length` is why truncation reads as a visible
 * fact rather than as items nobody notices are missing.
 *
 * Shared by the mint-tasks dialog and the dev-tools enrichment trace.
 */
import type { MintContextBlock } from "@/lib/api";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { useState } from "react";

export function ContextBlockRow({ block }: { block: MintContextBlock }) {
  const [expanded, setExpanded] = useState(false);
  const empty = block.items.length === 0;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => !empty && setExpanded((v) => !v)}
        disabled={empty}
        className="flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
      >
        <CaretRightIcon
          size={12}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""} ${
            empty ? "opacity-0" : ""
          }`}
        />
        <span className="text-sm font-medium">{block.label}</span>
        <span className={`text-xs ${empty ? "text-muted-foreground" : ""}`}>
          {block.truncated ? `${block.items.length} of ${block.total}` : block.total}
        </span>
        {block.via === "tool" && (
          <Badge variant="outline" className="text-[10px]">
            fetched by model
          </Badge>
        )}
        <span className="ml-auto truncate text-xs text-muted-foreground">{block.selection}</span>
      </button>

      {expanded && (
        <ul className="border-t border-border px-3 py-2 space-y-1">
          {block.items.map((item) => (
            <li key={item} className="text-xs text-muted-foreground break-words whitespace-pre-wrap">
              {item}
            </li>
          ))}
          {block.truncated && (
            <li className="text-xs italic text-muted-foreground">
              {block.total - block.items.length} more matched the rule but were not sent.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
