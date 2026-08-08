import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ServiceWorker } from '@/components/service-worker';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
