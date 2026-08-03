import type { AutomationArtifact } from "@sketch/shared";

function artifactLinkLine(artifact: AutomationArtifact, label: string): string | null {
  const url = artifact.builderUrl.trim();
  if (!url) return null;
  return `- ${label} - ${url}`;
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
  const artifactsByUrl = new Map<string, AutomationArtifact>();
  for (const artifact of artifacts) {
    const url = artifact.builderUrl.trim();
    if (url && !artifactsByUrl.has(url)) artifactsByUrl.set(url, artifact);
  }
  const distinctArtifacts = Array.from(artifactsByUrl.values());
  const linkLabel = distinctArtifacts.length === 1 ? "Open your automation" : "Open your automations";
  const missingLinks = distinctArtifacts
    .filter((artifact) => {
      const references = builderUrlReferences(artifact.builderUrl);
      return references.length > 0 && references.every((reference) => !text.includes(reference));
    })
    .map((artifact) => artifactLinkLine(artifact, linkLabel))
    .filter((line): line is string => Boolean(line));

  if (missingLinks.length === 0) return text || null;

  const linkBlock = missingLinks.join("\n");
  const fallback = "Your automation is ready.";
  return text ? `${text}\n\n${linkBlock}` : `${fallback}\n\n${linkBlock}`;
}
