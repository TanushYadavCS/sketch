/**
 * ConnectionsBanner — dark-mode marketing banner promoting per-member app connections.
 *
 * Static text block (left) with a decorative field of floating app icons (right column + bottom).
 * An ambient gradient orb animates idly and follows the cursor on hover. Icons repel from
 * the cursor with a spring transition (via the .cb-icon CSS class in index.css).
 *
 * All animation runs via requestAnimationFrame with direct DOM manipulation (no React re-renders).
 */
import { useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Icon inventory — positions are % of banner width (x) and height (y)
// ---------------------------------------------------------------------------

interface IconData {
  name: string;
  bg: string;
  x: number;
  y: number;
  size: number;
  rotation: number;
}

const ICONS: IconData[] = [
  { name: "HubSpot", bg: "#FF5C35", x: 83, y: 3, size: 36, rotation: 13 },
  { name: "Figma", bg: "#2C2C2C", x: 91, y: 12, size: 28, rotation: 9 },
  { name: "Zoom", bg: "#2D8CFF", x: 72, y: 22, size: 32, rotation: -12 },
  { name: "Slack", bg: "#4A154B", x: 88, y: 30, size: 34, rotation: 7 },
  { name: "Notion", bg: "#1F1F1F", x: 65, y: 38, size: 30, rotation: -9 },
  { name: "Linear", bg: "#434FCC", x: 90, y: 50, size: 24, rotation: 11 },
  { name: "Slack-alt", bg: "#3D1040", x: 74, y: 56, size: 28, rotation: -6 },
  { name: "Asana", bg: "#F06A6A", x: 3, y: 65, size: 28, rotation: -11 },
  { name: "Dropbox", bg: "#0061FE", x: 14, y: 72, size: 26, rotation: 8 },
  { name: "Gmail", bg: "#FFFFFF", x: 24, y: 64, size: 30, rotation: -7 },
  { name: "Intercom", bg: "#1F8DED", x: 36, y: 70, size: 26, rotation: 12 },
  { name: "Pipedrive", bg: "#1A3A5C", x: 47, y: 63, size: 28, rotation: -10 },
  { name: "Google Drive", bg: "#FFFFFF", x: 57, y: 71, size: 30, rotation: 6 },
  { name: "Google Calendar", bg: "#FFFFFF", x: 64, y: 68, size: 28, rotation: -9 },
  { name: "Figma-alt", bg: "#1A1A28", x: 78, y: 73, size: 24, rotation: 14 },
  { name: "HubSpot-alt", bg: "#C94A2C", x: 90, y: 67, size: 26, rotation: -5 },
];

// ---------------------------------------------------------------------------
// Simplified brand SVG icons
// ---------------------------------------------------------------------------

function BrandSvg({ name, size }: { name: string; size: number }) {
  const s = Math.round(size * 0.55);
  const base = name.replace("-alt", "");

  switch (base) {
    case "HubSpot":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" stroke="white" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="1.5" fill="white" />
          <line x1="12" y1="3" x2="12" y2="6.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="12" y1="17.5" x2="12" y2="21" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="4.2" y1="7.5" x2="7.2" y2="9.2" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="16.8" y1="14.8" x2="19.8" y2="16.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="4.2" y1="16.5" x2="7.2" y2="14.8" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="16.8" y1="9.2" x2="19.8" y2="7.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case "Figma":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="6" y="3" width="5" height="5" rx="2.5" fill="#F24E1E" />
          <rect x="13" y="3" width="5" height="5" rx="2.5" fill="#FF7262" />
          <rect x="6" y="9.5" width="5" height="5" rx="2.5" fill="#A259FF" />
          <circle cx="15.5" cy="12" r="2.5" fill="#1ABCFE" />
          <rect x="6" y="16" width="5" height="5" rx="2.5" fill="#0ACF83" />
        </svg>
      );

    case "Zoom":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="7" width="13" height="10" rx="2" fill="white" />
          <path d="M18 9.5L21.5 7.5V16.5L18 14.5V9.5Z" fill="white" />
        </svg>
      );

    case "Slack":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="10" y="3" width="3.5" height="8" rx="1.75" fill="#E01E5A" />
          <rect x="3" y="10" width="8" height="3.5" rx="1.75" fill="#36C5F0" />
          <rect x="10.5" y="13" width="3.5" height="8" rx="1.75" fill="#2EB67D" />
          <rect x="13" y="10" width="8" height="3.5" rx="1.75" fill="#ECB22E" />
        </svg>
      );

    case "Notion":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <text
            x="12"
            y="17"
            textAnchor="middle"
            fill="white"
            fontFamily="'Times New Roman', serif"
            fontSize="16"
            fontWeight="700"
          >
            N
          </text>
        </svg>
      );

    case "Linear":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3.5 20.5L2.2 19.2a1 1 0 010-1.4L18 2.2a1 1 0 011.4 0l1.3 1.3-16.5 17z" fill="white" opacity="0.9" />
          <path d="M7 21.5l14.5-14.5.8.8A10 10 0 017 21.5z" fill="white" opacity="0.7" />
        </svg>
      );

    case "Asana":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="6.5" r="3.5" fill="white" />
          <circle cx="6" cy="16" r="3.5" fill="white" />
          <circle cx="18" cy="16" r="3.5" fill="white" />
        </svg>
      );

    case "Dropbox":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3L6 7l6 4-6 4 6 4 6-4-6-4 6-4z" fill="white" />
        </svg>
      );

    case "Gmail":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" fill="#EA4335" opacity="0.15" />
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="#EA4335" strokeWidth="1.5" fill="none" />
          <path d="M3.5 6L12 13L20.5 6" stroke="#EA4335" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </svg>
      );

    case "Intercom":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="3" width="16" height="14" rx="3" fill="white" />
          <line x1="8" y1="7" x2="8" y2="12" stroke="#1F8DED" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="12" y1="6" x2="12" y2="13" stroke="#1F8DED" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="16" y1="7" x2="16" y2="12" stroke="#1F8DED" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M8 19L6 21" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case "Pipedrive":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="8" r="4" stroke="white" strokeWidth="2" fill="none" />
          <line x1="12" y1="12" x2="12" y2="21" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );

    case "Google Drive":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8.5 3.5L2 15h5.5L14 3.5z" fill="#0F9D58" />
          <path d="M15.5 3.5L22 15h-5.5L10 3.5z" fill="#FBBC04" />
          <path d="M2 15l3.25 5.5h13.5L22 15z" fill="#4285F4" />
        </svg>
      );

    case "Google Calendar":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" stroke="#4285F4" strokeWidth="1.8" fill="none" />
          <line x1="3" y1="10" x2="21" y2="10" stroke="#4285F4" strokeWidth="1.5" />
          <line x1="8" y1="5" x2="8" y2="2" stroke="#4285F4" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="16" y1="5" x2="16" y2="2" stroke="#4285F4" strokeWidth="1.8" strokeLinecap="round" />
          <text x="12" y="18" textAnchor="middle" fill="#EA4335" fontSize="8" fontWeight="700">
            31
          </text>
        </svg>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Main banner component
// ---------------------------------------------------------------------------

export function ConnectionsBanner({ onConnect }: { onConnect: () => void }) {
  const bannerRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const iconRefs = useRef<(HTMLDivElement | null)[]>([]);

  /** Mutable state for the orb idle drift. */
  const orbT = useRef(0);

  // ------- Orb idle drift (gradient only, no icon animation) -------
  useEffect(() => {
    let frameId: number;

    const loop = () => {
      orbT.current += 0.003;
      const t = orbT.current;

      if (orbRef.current && !bannerRef.current?.hasAttribute("data-mouse-active")) {
        const orbX = 75 + Math.sin(t) * 14;
        const orbY = 65 + Math.cos(t * 0.7) * 16;
        const orb2X = 100 - orbX * 0.4;
        const orb2Y = 100 - orbY * 0.3;

        orbRef.current.style.background = [
          `radial-gradient(ellipse 65% 60% at ${orbX}% ${orbY}%, rgba(254,237,1,0.12) 0%, rgba(254,237,1,0.03) 55%, transparent 75%)`,
          `radial-gradient(ellipse 45% 45% at ${orb2X}% ${orb2Y}%, rgba(212,196,0,0.07) 0%, transparent 65%)`,
        ].join(", ");
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, []);

  // ------- Shared icon updater -------
  const updateIcons = useCallback((mx: number, my: number) => {
    for (let i = 0; i < ICONS.length; i++) {
      const el = iconRefs.current[i];
      if (!el) continue;
      const icon = ICONS[i];

      // Parallax: shift based on cursor offset from centre, scaled per-icon depth
      const depth = 0.6 + (i % 5) * 0.1; // 0.6 – 1.0
      const shiftX = (mx - 0.5) * 20 * depth; // ±10px at edges
      const shiftY = (my - 0.5) * 20 * depth;

      // Clamp to ±10px
      const cx = Math.max(-10, Math.min(10, shiftX));
      const cy = Math.max(-10, Math.min(10, shiftY));

      el.style.transform = `translate(${cx}px, ${cy}px) rotate(${icon.rotation}deg)`;
    }
  }, []);

  const resetIcons = useCallback(() => {
    for (let i = 0; i < ICONS.length; i++) {
      const el = iconRefs.current[i];
      if (!el) continue;
      el.style.transform = `translate(0px, 0px) rotate(${ICONS[i].rotation}deg)`;
    }
  }, []);

  // ------- Mouse handlers -------
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = bannerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;

      // Move the orb to cursor
      bannerRef.current?.setAttribute("data-mouse-active", "");
      if (orbRef.current) {
        const orbX = mx * 100;
        const orbY = my * 100;
        const orb2X = 100 - orbX * 0.4;
        const orb2Y = 100 - orbY * 0.3;

        orbRef.current.style.background = [
          `radial-gradient(ellipse 65% 60% at ${orbX}% ${orbY}%, rgba(254,237,1,0.12) 0%, rgba(254,237,1,0.03) 55%, transparent 75%)`,
          `radial-gradient(ellipse 45% 45% at ${orb2X}% ${orb2Y}%, rgba(212,196,0,0.07) 0%, transparent 65%)`,
        ].join(", ");
      }

      // Shift icons
      updateIcons(mx, my);
    },
    [updateIcons],
  );

  const handleMouseLeave = useCallback(() => {
    bannerRef.current?.removeAttribute("data-mouse-active");
    resetIcons();
  }, [resetIcons]);

  return (
    <div
      ref={bannerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="relative w-full overflow-hidden rounded-2xl border bg-[#111110]"
      style={{ borderColor: "rgba(254, 237, 1, 0.15)" }}
    >
      {/* Ambient gradient orb — background set dynamically by rAF */}
      <div ref={orbRef} className="pointer-events-none absolute inset-0" />

      {/* Floating icons — position/size/rotation/bg come from ICONS data */}
      {ICONS.map((icon, i) => (
        <div
          key={`${icon.name}-${icon.x}-${icon.y}`}
          ref={(el) => {
            iconRefs.current[i] = el;
          }}
          className="cb-icon pointer-events-none absolute flex items-center justify-center overflow-hidden"
          style={{
            left: `${icon.x}%`,
            top: `${icon.y}%`,
            width: icon.size,
            height: icon.size,
            borderRadius: Math.floor(icon.size * 0.26),
            background: icon.bg,
            opacity: 0.82,
            border: "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 4px 18px rgba(0, 0, 0, 0.50)",
            transform: `rotate(${icon.rotation}deg)`,
          }}
        >
          <BrandSvg name={icon.name} size={icon.size} />
        </div>
      ))}

      {/* Horizontal gradient mask — protects text from icon bleed */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to right, #111110 55%, rgba(17,17,16,0.60) 63%, rgba(17,17,16,0.15) 72%, transparent 82%)",
        }}
      />

      {/* Vertical gradient mask — fades icons into bottom edge */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, transparent 55%, rgba(17,17,16,0.25) 68%, rgba(17,17,16,0.55) 88%, rgba(17,17,16,0.75) 100%)",
        }}
      />

      {/* Text content */}
      <div className="relative z-10 max-w-[60%] px-8 py-6">
        {/* Heading */}
        <h2
          className="mb-2.5 text-[18px] font-normal leading-snug tracking-tight whitespace-nowrap text-white"
          style={{ fontFamily: "'Gloria Hallelujah', cursive" }}
        >
          Let your team connect their{" "}
          <span
            className="bg-gradient-to-r from-white to-[#FEED01] bg-clip-text font-normal italic text-transparent"
            style={{ fontFamily: "'Gloria Hallelujah', cursive" }}
          >
            own apps, securely.
          </span>
        </h2>

        {/* Body */}
        <p
          className="my-3 text-[13px] font-normal leading-relaxed text-[#9ca3af]"
          style={{ fontFamily: "'Inter', sans-serif" }}
        >
          Each member authorizes with their own credentials —
          <br />
          no shared access, no admin bottlenecks.
        </p>

        {/* CTA */}
        <button
          type="button"
          onClick={onConnect}
          className="group inline-flex cursor-pointer items-center border-none bg-transparent p-0"
          style={{ fontFamily: "'Inter', sans-serif" }}
        >
          <span className="text-[13px] font-medium text-[#FEED01] transition-colors duration-200 group-hover:text-white">
            Connect
          </span>
          <span className="ml-1.5 text-base text-[#FEED01] transition-all duration-200 group-hover:ml-2.5 group-hover:text-white">
            &rarr;
          </span>
        </button>
      </div>
    </div>
  );
}
