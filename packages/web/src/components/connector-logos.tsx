/**
 * Brand SVG logos for connector integrations.
 *
 * All icons use viewBox="0 0 24 24" and fill="currentColor" so they
 * inherit the parent's text color. Wrap in a colored container to
 * show the brand color, or apply the color directly.
 *
 * Source: Simple Icons (CC0 1.0 Universal license).
 */

interface LogoProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function GoogleDriveLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z" />
    </svg>
  );
}

export function GmailLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
    </svg>
  );
}

export function GoogleCalendarLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M6 2h2v2h8V2h2v2h1.5A2.5 2.5 0 0 1 22 6.5v13A2.5 2.5 0 0 1 19.5 22h-15A2.5 2.5 0 0 1 2 19.5v-13A2.5 2.5 0 0 1 4.5 4H6V2Zm14 8H4v9.5c0 .28.22.5.5.5h15a.5.5 0 0 0 .5-.5V10ZM4.5 6a.5.5 0 0 0-.5.5V8h16V6.5a.5.5 0 0 0-.5-.5h-15Zm4 7h3v3h-3v-3Zm5 0h3v3h-3v-3Z" />
    </svg>
  );
}

export function OutlookLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M3 4.5 13.5 2v20L3 19.5v-15Zm4.9 10.3c1.7 0 2.9-1.4 2.9-3.3s-1.2-3.3-2.9-3.3S5 9.6 5 11.5s1.2 3.3 2.9 3.3Zm0-1.4c-.8 0-1.3-.7-1.3-1.9s.5-1.9 1.3-1.9 1.3.7 1.3 1.9-.5 1.9-1.3 1.9ZM15 5h6v14h-6v-2h4v-6.1l-2.5 1.7L15 11.5V5Zm1.2 2v2.7l.3.2L19 8.2V7h-2.8Z" />
    </svg>
  );
}

export function TeamsLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M10.5 4.5h7A2.5 2.5 0 0 1 20 7v1.25h1.25A1.75 1.75 0 0 1 23 10v3.5A4.5 4.5 0 0 1 18.5 18H18a4.5 4.5 0 0 1-4.5 4.5h-3A2.5 2.5 0 0 1 8 20v-2H3.5A2.5 2.5 0 0 1 1 15.5v-7A2.5 2.5 0 0 1 3.5 6H8.1a2.5 2.5 0 0 1 2.4-1.5ZM10 6v12h3.5A2.5 2.5 0 0 0 16 15.5V7a.5.5 0 0 0-.5-.5H10Zm8 4v5.5c0 .17-.01.34-.03.5h.53A2.5 2.5 0 0 0 21 13.5V10h-3ZM4 10v2h1.7v4h2.1v-4h1.7v-2H4Zm14-3v1.25h1.5V7a.5.5 0 0 0-.5-.5h-1.05c.03.16.05.33.05.5Z" />
    </svg>
  );
}

export function ClickUpLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z" />
    </svg>
  );
}

export function NotionLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

export function LinearLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

/** Returns the brand logo component for a connector type, or null if unknown. */
export function ZohoLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M4 4h16v3.4l-9.4 9.4H20V20H4v-3.4L13.4 7.2H4z" />
    </svg>
  );
}

export function OtterLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M4 9.5a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0v-5Zm6-3.5a2 2 0 0 1 4 0v12a2 2 0 0 1-4 0V6Zm6 3.5a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0v-5Z" />
    </svg>
  );
}

export function ConnectorLogo({
  type,
  size = 16,
  className,
  style,
}: {
  type: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const props = { size, className, style };
  switch (type) {
    case "google_drive":
      return <GoogleDriveLogo {...props} />;
    case "gmail":
      return <GmailLogo {...props} />;
    case "google_calendar":
      return <GoogleCalendarLogo {...props} />;
    case "outlook":
      return <OutlookLogo {...props} />;
    case "teams":
      return <TeamsLogo {...props} />;
    case "clickup":
      return <ClickUpLogo {...props} />;
    case "notion":
      return <NotionLogo {...props} />;
    case "linear":
      return <LinearLogo {...props} />;
    case "otter":
      return <OtterLogo {...props} />;
    case "zoho_crm":
      return <ZohoLogo {...props} />;
    default:
      return null;
  }
}
