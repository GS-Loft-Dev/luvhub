import type { ReactNode, SVGProps } from "react";

/* ------------------------------------------------------------------ brand */

/** The luvhub mark: a tilted orbit with a hub riding on it. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <ellipse cx="16" cy="16" rx="12.2" ry="7.4" transform="rotate(-32 16 16)" fill="none" stroke="#fff" strokeWidth="3.6" />
      <circle cx="25.6" cy="9.4" r="3.1" fill="#fff" stroke="#0c0c0d" strokeWidth="1.6" />
    </svg>
  );
}

export function Logo({ href = "/", word = true }: { href?: string; word?: boolean }) {
  return (
    <a className="brand" href={href} aria-label="luvhub home">
      <Mark />
      {word && <span className="brand-word">luvhub</span>}
    </a>
  );
}

/* ------------------------------------------------------------------ icons */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      {children}
    </svg>
  );
}

export const I = {
  source: (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Icon>,
  layers: (p: IconProps) => <Icon {...p}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></Icon>,
  upload: (p: IconProps) => <Icon {...p}><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Icon>,
  book: (p: IconProps) => <Icon {...p}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></Icon>,
  arrow: (p: IconProps) => <Icon {...p}><path d="M7 17 17 7M8 7h9v9" /></Icon>,
  check: (p: IconProps) => <Icon {...p} strokeWidth="3"><path d="m5 12 5 5 9-10" /></Icon>,
  search: (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>,
  download: (p: IconProps) => <Icon {...p}><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 20h16" /></Icon>,
  close: (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>,
  image: (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></Icon>,
  file: (p: IconProps) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></Icon>,
  fields: (p: IconProps) => <Icon {...p}><path d="M4 7h16M4 12h10M4 17h7" /></Icon>,
  chart: (p: IconProps) => <Icon {...p}><path d="M4 20V10M10 20V4M16 20v-7M21 20H3" /></Icon>,
  bolt: (p: IconProps) => <Icon {...p} fill="currentColor" stroke="none"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></Icon>,
  plus: (p: IconProps) => <Icon {...p} strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></Icon>,
  refresh: (p: IconProps) => <Icon {...p}><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.6" /><path d="M20 4v4.6h-4.6" /></Icon>,
  cpu: (p: IconProps) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></Icon>,
  home: (p: IconProps) => <Icon {...p}><path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-8Z" /></Icon>,
  chevron: (p: IconProps) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>,
  calendar: (p: IconProps) => <Icon {...p}><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16M9 3v4M15 3v4" /></Icon>,
  logout: (p: IconProps) => <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 8 6 12l4 4M6 12h10" /></Icon>,
  login: (p: IconProps) => <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m11 8 4 4-4 4M15 12H4" /></Icon>,
  trend: (p: IconProps) => <Icon {...p}><path d="m4 16 5-5 4 3 7-7" /><path d="M15 7h5v5" /></Icon>,
  eye: (p: IconProps) => <Icon {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Icon>,
  play: (p: IconProps) => <Icon {...p}><path d="M7 5v14l12-7L7 5Z" /></Icon>,
  left: (p: IconProps) => <Icon {...p}><path d="m15 6-6 6 6 6" /></Icon>,
  right: (p: IconProps) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>,
  dots: (p: IconProps) => <Icon {...p} strokeWidth="2.6"><path d="M12 5h.01M12 12h.01M12 19h.01" /></Icon>,
  save: (p: IconProps) => <Icon {...p}><path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4Z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></Icon>,
  menu: (p: IconProps) => <Icon {...p}><path d="M5 7h14M5 12h14M5 17h14" /></Icon>,
  minus: (p: IconProps) => <Icon {...p} strokeWidth="2"><path d="M5 12h14" /></Icon>,
  fit: (p: IconProps) => <Icon {...p}><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></Icon>,
  share: (p: IconProps) => <Icon {...p}><path d="M12 15V4M8 8l4-4 4 4" /><path d="M5 13v6h14v-6" /></Icon>,
  external: (p: IconProps) => <Icon {...p}><path d="M20 12a8 8 0 1 1-8-8" /><path d="M14 4h6v6M20 4l-8 8" /></Icon>,
  history: (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4l3 2" /></Icon>,
  cube: (p: IconProps) => <Icon {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></Icon>,
  sun: (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="3.5" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></Icon>,
  gear: (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" /></Icon>,
  sparkle: (p: IconProps) => <Icon {...p}><path d="M12 4v4M12 16v4M4 12h4M16 12h4M7 7l2 2M15 15l2 2M7 17l2-2M15 9l2-2" /></Icon>,
  cursor: (p: IconProps) => <Icon {...p} fill="currentColor" stroke="none"><path d="M4 3 20 10l-7 2.5L10.5 20 4 3Z" /></Icon>,
  reset: (p: IconProps) => <Icon {...p}><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6" /><path d="M4 4v4.6h4.6" /></Icon>,
};

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}
