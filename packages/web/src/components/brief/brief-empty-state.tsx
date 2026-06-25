import { SparkleIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { BriefSection } from "./brief-section";
import { BRIEF_SECTIONS } from "./sections";

export function DailyBriefEmptyState({
  loading,
  running,
  generating,
  onGenerate,
}: {
  loading: boolean;
  running: boolean;
  generating: boolean;
  onGenerate: () => void;
}) {
  const active = running || generating;

  return (
    <div>
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">The Brief</p>
        <h1 className="mt-3 font-serif text-[32px] font-medium leading-[1.1] tracking-[-0.01em] text-foreground">
          {active ? "Assembling today's brief" : "Your brief, every morning"}
        </h1>
        <p className="mt-2.5 max-w-xl font-serif text-[16px] italic leading-relaxed text-muted-foreground">
          {active
            ? "“Reading across your org knowledge — this only takes a moment.”"
            : "“Sketch assembles a brief from your org knowledge every morning at 8am.”"}
        </p>
        {active ? (
          <p className="mt-4 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
            <SparkleIcon size={12} weight="fill" className="animate-pulse text-amber-500" aria-hidden />
            Generating&hellip;
          </p>
        ) : (
          <Button type="button" className="mt-5" onClick={onGenerate} disabled={loading}>
            <SparkleIcon size={16} />
            Generate today's brief
          </Button>
        )}
      </header>

      <div className="mt-8 flex flex-col gap-8">
        {BRIEF_SECTIONS.map((section) => (
          <BriefSection key={section.key} label={section.label}>
            <p className="mb-2.5 text-[12.5px] leading-relaxed text-muted-foreground/80">{section.promise}</p>
            <div className={`flex flex-col gap-1.5 ${active ? "" : "opacity-40"}`} aria-hidden>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`h-[13px] rounded bg-muted/60 ${active ? "animate-pulse" : ""}`}
                  style={{ width: `${78 - i * 16}%` }}
                />
              ))}
            </div>
          </BriefSection>
        ))}
      </div>
    </div>
  );
}
