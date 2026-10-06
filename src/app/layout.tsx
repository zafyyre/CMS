import type { Metadata, Viewport } from 'next';
import { leagueBrandColor, leagueThemeStyle } from '@/components/league-theme';
import { ServiceWorker } from '@/components/service-worker';
import { type HeaderAccount, Masthead } from '@/components/site/masthead';
import { PageFooter } from '@/components/site/page-footer';
import { SECTIONS } from '@/components/site/sections';
import { getPrincipal } from '@/server/auth/principal';
import { adminSections } from '@/server/authz/admin-sections';
import type { Principal } from '@/server/authz/roles';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import './globals.css';

/*
 * No webfont is loaded, deliberately.
 *
 * The reference design names Inter first in its font stack but ships no
 * @font-face and links no font, so it renders in whatever the visitor's system
 * provides — Segoe UI on Windows, SF on macOS, Roboto on Android. The product
 * reproduces that exactly, by the owner's decision, so the stack lives in
 * globals.css as `--font-sans` and there is nothing to download here. This also
 * drops two font requests from every first page load.
 */

/**
 * Titles come from the LEAGUE, not from a constant.
 *
 * Each league has its own domain, so a hard-coded title would put one league's
 * name in another's browser tab and, more consequentially, in the search
 * results and link previews that are how most people arrive.
 */
export async function generateMetadata(): Promise<Metadata> {
  const league = await getCurrentLeague();
  const name = league?.name ?? 'League';

  return {
    title: {
      default: name,
      // Every page sets its own title; this puts the league after it.
      template: `%s · ${name}`,
    },
    description: `Fixtures, results, standings and field status for ${name}.`,
    applicationName: name,
    appleWebApp: {
      capable: true,
      title: league?.shortName ?? name,
      statusBarStyle: 'default',
    },
    formatDetection: {
      // iOS otherwise turns "2025-26" and every scoreline into a phone link.
      telephone: false,
    },
    openGraph: {
      siteName: name,
      type: 'website',
    },
  };
}

/**
 * Per league, like the title: the browser's toolbar takes the colour at the
 * top of the site header, so on a phone the two read as one surface — and a
 * league with its own brand colour gets its own toolbar.
 */
export async function generateViewport(): Promise<Viewport> {
  const league = await getCurrentLeague();
  return {
    themeColor: leagueBrandColor(league?.theme, 'brand-800'),
    // Zoom is left enabled deliberately. A large part of this readership is
    // over fifty and reading a table outdoors; pinch-to-zoom is how they cope
    // with a column that is too small, and disabling it is a WCAG failure
    // besides.
    maximumScale: 5,
    width: 'device-width',
    initialScale: 1,
  };
}

/**
 * The two-letter badge in the header: the first letters of the league's first
 * two words, or the first two letters of a one-word name.
 */
function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/** The optional strapline under the league's name, from its settings. */
function tagline(settings: unknown): string | null {
  const value = (settings as { tagline?: unknown } | null)?.tagline;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const ADMIN_ROLES = new Set(['PLATFORM_OWNER', 'LEAGUE_ADMIN', 'REGISTRAR', 'DISCIPLINE_OFFICER']);

/**
 * Where the header's account control leads, and how it is labelled. Anyone
 * whose roles open an admin section goes there — nothing else in the public
 * site links to it — and everyone else to their account page. The glyph is
 * decorative, chosen from their most senior role.
 */
function headerAccount(principal: Principal | null): HeaderAccount | null {
  if (!principal) return null;
  if (adminSections(principal).any) return { href: '/admin', label: 'Admin', icon: '⚙️' };
  const roles = new Set(principal.roles.map((r) => r.role));
  const icon = [...roles].some((role) => ADMIN_ROLES.has(role))
    ? '⚙️'
    : roles.has('REFEREE') || roles.has('REFEREE_ASSIGNOR')
      ? '🧑‍⚖️'
      : roles.has('CLUB_ADMIN') || roles.has('TEAM_MANAGER') || roles.has('COACH')
        ? '📋'
        : roles.has('PLAYER')
          ? '⚽'
          : '👤';
  return { href: '/account', label: 'My account', icon };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /**
   * The league's accent is seeded HERE, on `<html>`, and nowhere else.
   *
   * It used to be spread onto each page's own `<main>` — 17 call sites — where
   * it could not work. CSS substitutes `var()` inside a custom property at
   * computed-value time *on the element carrying the declaration*, and the
   * token derived from the accent is declared on `:root`. Descendants
   * therefore inherit an already-substituted value, so overriding
   * `--accent-hue` further down the tree changed nothing.
   *
   * On `<html>` the override lands on the same element the token is declared
   * on, so the derivation actually sees it, and the skip link and anything
   * portalled to `document.body` fall inside it too.
   *
   * What it reaches: the accent, which tints the keyboard focus ring, and the
   * brand colours the header, footer and buttons are drawn from — only the
   * allowlisted tokens, each validated before it is written into the style
   * attribute (see league-theme.tsx). A league that sets
   * nothing renders exactly like the reference design. Any tenant variable
   * added later belongs here for the same reason: it must be seeded on the
   * element its dependants are declared on.
   *
   * `getCurrentLeague()` is wrapped in React `cache()`, so sharing it with
   * `generateMetadata()` above costs one query per request, not two.
   */
  const [league, principal] = await Promise.all([getCurrentLeague(), getPrincipal()]);
  const leagueName = league?.name ?? 'League';

  return (
    <html
      lang="en"
      className="h-full antialiased"
      style={leagueThemeStyle(league?.theme)}
    >
      <body className="min-h-full flex flex-col">
        {/* First focusable element on every page: a table of forty rows is a
            long way to tab past for somebody using a keyboard. Stacked above
            the sticky site header (z-index 50), which comes later in the page
            and would otherwise cover it at the same level. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:outline focus:outline-2"
        >
          Skip to content
        </a>
        <Masthead
          leagueName={leagueName}
          monogram={monogram(leagueName)}
          tagline={tagline(league?.settings)}
          account={headerAccount(principal)}
          sections={SECTIONS}
        />
        {children}
        <PageFooter leagueName={leagueName} />
        <ServiceWorker />
      </body>
    </html>
  );
}
