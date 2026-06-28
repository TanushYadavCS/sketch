export type PersonalCanvasConnectorType =
  | "google_drive"
  | "google_calendar"
  | "gmail"
  | "outlook"
  | "teams"
  | "fireflies";

export interface PersonalCanvasConnectorMapping {
  connectorType: PersonalCanvasConnectorType;
  appSlug: string;
  aliases: string[];
}

export const PERSONAL_CANVAS_CONNECTOR_MAPPINGS: PersonalCanvasConnectorMapping[] = [
  {
    connectorType: "google_drive",
    appSlug: "google-drive-oauth",
    aliases: ["google-drive-oauth", "google-drive", "google_drive", "drive"],
  },
  {
    connectorType: "google_calendar",
    appSlug: "google-calendar-oauth",
    aliases: ["google-calendar-oauth", "google-calendar", "google_calendar", "calendar"],
  },
  {
    connectorType: "gmail",
    appSlug: "google-gmail-oauth",
    aliases: ["google-gmail-oauth", "google-gmail", "google_gmail", "gmail"],
  },
  {
    connectorType: "outlook",
    appSlug: "microsoft-outlook-oauth",
    aliases: ["microsoft-outlook-oauth", "microsoft-outlook", "microsoft_outlook", "outlook"],
  },
  {
    connectorType: "teams",
    appSlug: "microsoft-teams-oauth",
    aliases: ["microsoft-teams-oauth", "microsoft-teams", "microsoft_teams", "teams"],
  },
  {
    connectorType: "fireflies",
    appSlug: "fireflies",
    aliases: ["fireflies", "fireflies-ai"],
  },
];

function normalizeCanvasAppId(value: string): string {
  return value.trim().toLowerCase();
}

const connectorByAlias = new Map<string, PersonalCanvasConnectorType>(
  PERSONAL_CANVAS_CONNECTOR_MAPPINGS.flatMap((mapping) =>
    mapping.aliases.map((alias) => [normalizeCanvasAppId(alias), mapping.connectorType] as const),
  ),
);

const appSlugByConnector = new Map<PersonalCanvasConnectorType, string>(
  PERSONAL_CANVAS_CONNECTOR_MAPPINGS.map((mapping) => [mapping.connectorType, mapping.appSlug]),
);

export function personalCanvasConnectorTypeFromAppId(appId: string): PersonalCanvasConnectorType | null {
  return connectorByAlias.get(normalizeCanvasAppId(appId)) ?? null;
}

export function canvasAppSlugForPersonalConnector(connectorType: PersonalCanvasConnectorType): string {
  return appSlugByConnector.get(connectorType) ?? connectorType;
}
