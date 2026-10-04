// The mockup's icons (docs/mockups/icons.js) as inline SVG: no extra request, colour from CSS.
import type { Lang } from '@idoknow/shared';

const PATHS = {
  heart: (
    <path d="M12 21s-7.4-4.5-9.5-9.2C1 8.3 3.1 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3.1 1.7-2 3.2-3.1 5.3-3.1 3.6 0 5.7 3.8 4.2 7.3C19.4 16.5 12 21 12 21z" />
  ),
  flower: (
    <>
      <circle cx="12" cy="6.6" r="4.1" />
      <circle cx="17.1" cy="10.3" r="4.1" />
      <circle cx="15.2" cy="16.4" r="4.1" />
      <circle cx="8.8" cy="16.4" r="4.1" />
      <circle cx="6.9" cy="10.3" r="4.1" />
    </>
  ),
  star: <path d="M12 2.2l3 6.2 6.8.9-5 4.7 1.3 6.8L12 17.5l-6.1 3.3 1.3-6.8-5-4.7 6.8-.9z" />,
  moon: <path d="M20.5 14.6A9 9 0 0 1 9.4 3.5a9 9 0 1 0 11.1 11.1z" />,
  check: (
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  x: (
    <path
      d="M6.5 6.5l11 11M17.5 6.5l-11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    />
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M15.5 15.5L21 21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
  signal: <path d="M4 19h2v-3H4zm5 0h2v-6H9zm5 0h2V9h-2zm5 0h2V5h-2z" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </>
  ),
  up: <path d="M12 6l7 9H5z" />,
  down: <path d="M12 18l7-9H5z" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'ic' }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

// Flags are drawn in CSS (they look the same on Windows, where emoji flags don't exist).

/** A language: pl, es, ca (Catalan), de, en (an "EN" badge). */
export function LangFlag({ lang }: { lang: Lang }) {
  return <span className={`flag lang-${lang}`} aria-hidden="true" />;
}

const COUNTRY_FLAGS = new Set(['PL', 'ES', 'DE']);

/** A guest's country (guests.json, e.g. "PL"). Countries without a drawn flag show their code. */
export function CountryFlag({ code }: { code: string }) {
  return COUNTRY_FLAGS.has(code) ? (
    <span className={`flag cc-${code.toLowerCase()}`} aria-hidden="true" />
  ) : (
    <span className="flag cc-other" aria-hidden="true">
      {code}
    </span>
  );
}
