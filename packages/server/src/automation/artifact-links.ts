import type { AutomationArtifact } from "@sketch/shared";

function artifactLinkLine(artifact: AutomationArtifact): string | null {
  const url = artifact.builderUrl.trim();
  if (!url) return null;
  return `- ${artifact.title}: ${url}`;
}

function builderUrlReferences(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const references = new Set([trimmed]);
  try {
    const url = new URL(trimmed);
    references.add(`${url.pathname}${url.search}${url.hash}`);
  } catch {}
  return Array.from(references);
}

export function appendAutomationBuilderLinks(
  finalText: string | null | undefined,
  artifacts: AutomationArtifact[],
): string | null {
  const text = finalText?.trim() ?? "";
  const missingLinks = artifacts
    .filter((artifact) => {
      const references = builderUrlReferences(artifact.builderUrl);
      return references.length > 0 && references.every((reference) => !text.includes(reference));
    })
    .map(artifactLinkLine)
    .filter((line): line is string => Boolean(line));

  if (missingLinks.length === 0) return text || null;

  const linkBlock =
    missingLinks.length === 1 ? `Builder link:\n${missingLinks[0]}` : `Builder links:\n${missingLinks.join("\n")}`;
  return text ? `${text}\n\n${linkBlock}` : `Automation created.\n\n${linkBlock}`;
}
