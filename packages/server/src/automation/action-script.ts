import type { AutomationSketchToolName } from "@sketch/shared";

const sketchToolReferencePattern = /\bctx\.tools\.(search|searchEntities|getEntityContext|findTeammate)\b/g;
const invalidSketchToolNamespacePattern = /\bctx\.(?:sketch|sketchTools)\b/;
const integrationActionReferencePattern = /\bctx\.integrations\.executeAction\b/;
const rawCanvasCliReferencePattern =
  /(?:\b(?:ctx|process)\.env\.(?:CANVAS_CLI|INTEGRATION_CLI)\b|\$\{?(?:CANVAS_CLI|INTEGRATION_CLI)\}?)/;

export function hasInvalidAutomationSketchToolNamespace(script: string): boolean {
  return invalidSketchToolNamespacePattern.test(script);
}

export function referencesAutomationIntegrationAction(script: string): boolean {
  return integrationActionReferencePattern.test(script);
}

export function referencesRawCanvasCli(script: string): boolean {
  return rawCanvasCliReferencePattern.test(script);
}

export function referencedAutomationSketchTools(script: string): AutomationSketchToolName[] {
  const referenced = new Set<AutomationSketchToolName>();
  for (const match of script.matchAll(sketchToolReferencePattern)) {
    referenced.add(match[1] as AutomationSketchToolName);
  }
  return [...referenced];
}

export function undeclaredAutomationSketchTools(
  script: string,
  allowedTools: readonly AutomationSketchToolName[],
): AutomationSketchToolName[] {
  const allowed = new Set(allowedTools);
  return referencedAutomationSketchTools(script).filter((tool) => !allowed.has(tool));
}
