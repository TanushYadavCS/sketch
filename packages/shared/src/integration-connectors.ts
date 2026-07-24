export type PersonalCanvasConnectorType =
  | "google_drive"
  | "google_calendar"
  | "gmail"
  | "outlook"
  | "teams"
  | "fireflies";

export type OrganizationCanvasConnectorType = "linear";

export type CanvasConnectorType = PersonalCanvasConnectorType | OrganizationCanvasConnectorType;

export type CanvasConnectorCredentialScope = "personal" | "organization";

export interface CanvasConnectorMapping<TConnector extends CanvasConnectorType = CanvasConnectorType> {
  connectorType: TConnector;
  appSlug: string;
  aliases: string[];
  credentialScope: CanvasConnectorCredentialScope;
}

export interface PersonalCanvasConnectorMapping extends CanvasConnectorMapping<PersonalCanvasConnectorType> {
  credentialScope: "personal";
}

export interface OrganizationCanvasConnectorMapping extends CanvasConnectorMapping<OrganizationCanvasConnectorType> {
  credentialScope: "organization";
}

const PERSONAL_CANVAS_CONNECTOR_MAPPING_VALUES: PersonalCanvasConnectorMapping[] = [
  {
    connectorType: "google_drive",
    appSlug: "google-drive-oauth",
    aliases: ["google-drive-oauth", "google-drive", "google_drive", "drive"],
    credentialScope: "personal",
  },
  {
    connectorType: "google_calendar",
    appSlug: "google-calendar-oauth",
    aliases: ["google-calendar-oauth", "google-calendar", "google_calendar", "calendar"],
    credentialScope: "personal",
  },
  {
    connectorType: "gmail",
    appSlug: "google-gmail-oauth",
    aliases: ["google-gmail-oauth", "google-gmail", "gmail"],
    credentialScope: "personal",
  },
  {
    connectorType: "outlook",
    appSlug: "microsoft-outlook-oauth",
    aliases: ["microsoft-outlook-oauth", "microsoft-outlook", "outlook"],
    credentialScope: "personal",
  },
  {
    connectorType: "teams",
    appSlug: "microsoft-teams-oauth",
    aliases: ["microsoft-teams-oauth", "microsoft-teams", "teams"],
    credentialScope: "personal",
  },
  {
    connectorType: "fireflies",
    appSlug: "fireflies",
    aliases: ["fireflies", "fireflies-ai"],
    credentialScope: "personal",
  },
];

export const CANVAS_CONNECTOR_MAPPINGS: Array<PersonalCanvasConnectorMapping | OrganizationCanvasConnectorMapping> = [
  ...PERSONAL_CANVAS_CONNECTOR_MAPPING_VALUES,
  {
    connectorType: "linear",
    appSlug: "linear",
    aliases: ["linear"],
    credentialScope: "organization",
  },
];

export const PERSONAL_CANVAS_CONNECTOR_MAPPINGS: PersonalCanvasConnectorMapping[] = CANVAS_CONNECTOR_MAPPINGS.filter(
  (mapping): mapping is PersonalCanvasConnectorMapping => mapping.credentialScope === "personal",
);

function normalizeCanvasAppId(value: string): string {
  return value.trim().toLowerCase();
}

const connectorByAlias = new Map<string, CanvasConnectorType>(
  CANVAS_CONNECTOR_MAPPINGS.flatMap((mapping) =>
    mapping.aliases.map((alias) => [normalizeCanvasAppId(alias), mapping.connectorType] as const),
  ),
);

const mappingByConnector = new Map<
  CanvasConnectorType,
  PersonalCanvasConnectorMapping | OrganizationCanvasConnectorMapping
>(CANVAS_CONNECTOR_MAPPINGS.map((mapping) => [mapping.connectorType, mapping]));

const appSlugByConnector = new Map<CanvasConnectorType, string>(
  CANVAS_CONNECTOR_MAPPINGS.map((mapping) => [mapping.connectorType, mapping.appSlug]),
);

export function canvasConnectorTypeFromAppId(appId: string): CanvasConnectorType | null {
  return connectorByAlias.get(normalizeCanvasAppId(appId)) ?? null;
}

export function canvasConnectorMappingForType(
  connectorType: CanvasConnectorType | string,
): PersonalCanvasConnectorMapping | OrganizationCanvasConnectorMapping | null {
  return mappingByConnector.get(connectorType as CanvasConnectorType) ?? null;
}

export function canvasAppSlugForConnector(connectorType: CanvasConnectorType): string {
  return appSlugByConnector.get(connectorType) ?? connectorType;
}

export function personalCanvasConnectorTypeFromAppId(appId: string): PersonalCanvasConnectorType | null {
  const connectorType = canvasConnectorTypeFromAppId(appId);
  if (!connectorType) return null;
  const mapping = canvasConnectorMappingForType(connectorType);
  return mapping?.credentialScope === "personal" ? mapping.connectorType : null;
}

export function canvasAppSlugForPersonalConnector(connectorType: PersonalCanvasConnectorType): string {
  return canvasAppSlugForConnector(connectorType);
}
