import type { Metadata, Viewport } from 'next';
import { leagueThemeStyle } from '@/components/league-theme';
import { ServiceWorker } from '@/components/service-worker';
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

export const viewport: Viewport = {
  themeColor: '#0f172a',
  // Zoom is left enabled deliberately. A large part of this readership is over
  // fifty and reading a table outdoors; pinch-to-zoom is how they cope with a
  // column that is too small, and disabling it is a WCAG failure besides.
  maximumScale: 5,
  width: 'device-width',
  initialScale: 1,
};

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
   * What it reaches today is deliberately small: only `--ring`, the keyboard
   * focus outline. Every other colour is a fixed value taken from the
   * reference design, so a league that sets nothing renders exactly like it.
   * Letting a league restyle its brand colours is a later step, and when it
   * lands it belongs here for the same reason: any tenant variable must be
   * seeded on the element its dependants are declared on.
   *
   * `getCurrentLeague()` is wrapped in React `cache()`, so sharing it with
   * `generateMetadata()` above costs one query per request, not two.
   */
  const league = await getCurrentLeague();

  return (
    <html
      lang="en"
      className="h-full antialiased"
      style={leagueThemeStyle(league?.theme)}
    >
      <body className="min-h-full flex flex-col">
        {/* First focusable element on every page: a table of forty rows is a
            long way to tab past for somebody using a keyboard. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:outline focus:outline-2"
        >
          Skip to content
        </a>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
