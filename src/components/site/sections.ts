/**
 * The site's sections — the single list behind the header navigation and the
 * footer, so the two can never offer different pages.
 *
 * Only pages that exist are listed. Discipline, referees, registration and the
 * member areas arrive with their own phases and are added here then.
 */

export interface Section {
  label: string;
  href: string;
  /**
   * Other path prefixes that count as being inside this section, so the
   * header highlights it there too — a team's page is part of the clubs
   * section, for example.
   */
  also?: readonly string[];
}

export const SECTIONS: readonly Section[] = [
  { label: 'Home', href: '/' },
  { label: 'Schedule', href: '/schedule' },
  { label: 'This week', href: '/schedule/week' },
  { label: 'Standings', href: '/standings' },
  { label: 'Clubs', href: '/clubs', also: ['/teams'] },
  { label: 'Fields', href: '/fields' },
  { label: 'News', href: '/news' },
  { label: 'History', href: '/history' },
  { label: 'Documents', href: '/documents' },
];

/** The footer's two link columns. */
export const FOOTER_COLUMNS: readonly { heading: string; links: readonly Section[] }[] = [
  {
    heading: 'Explore',
    links: SECTIONS.filter((s) => ['/standings', '/schedule', '/schedule/week', '/fields'].includes(s.href)),
  },
  {
    heading: 'League',
    links: SECTIONS.filter((s) => ['/clubs', '/news', '/history', '/documents'].includes(s.href)),
  },
];

/**
 * Which of `sections` the current path belongs to — the MOST specific match,
 * so `/schedule/week` highlights "This week" and not "Schedule" as well.
 * Home matches only itself.
 */
export function currentSection(pathname: string, sections: readonly Section[]): string | null {
  let best: { href: string; length: number } | null = null;
  for (const section of sections) {
    for (const prefix of [section.href, ...(section.also ?? [])]) {
      const matches =
        prefix === '/' ? pathname === '/' : pathname === prefix || pathname.startsWith(`${prefix}/`);
      if (matches && (!best || prefix.length > best.length)) {
        best = { href: section.href, length: prefix.length };
      }
    }
  }
  return best?.href ?? null;
}
