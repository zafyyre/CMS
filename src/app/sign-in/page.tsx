import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/auth/sign-in-form';
import { leagueThemeStyle } from '@/components/league-theme';
import { getPrincipal } from '@/server/auth/principal';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * Sign in.
 *
 * The screen that has been missing since Phase 1: better-auth, the session
 * tables, the TOTP gate and the whole permission matrix were all built and
 * tested with no way for a human to actually log in.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in',
  // A sign-in page in a search index is noise at best.
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const league = await getCurrentLeague();
  const { next } = await searchParams;

  // Already signed in: nothing to do here.
  const principal = await getPrincipal();
  if (principal) redirect(safeNext(next));

  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-sm flex-col justify-center px-6 py-16"
      style={leagueThemeStyle(league?.theme)}
    >
      <Link
        href="/"
        className="text-xs font-medium uppercase tracking-widest text-muted-foreground hover:underline"
      >
        {league?.shortName ?? league?.slug ?? 'League'}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        For club officials, referees and league staff. The public pages need no account.
      </p>

      <SignInForm next={safeNext(next)} />
    </main>
  );
}

/**
 * Only ever redirect to a path on this site.
 *
 * `?next=https://evil.example` would otherwise turn the league's own sign-in
 * page into an open redirect — the classic way a phishing link acquires a
 * trustworthy-looking domain. Anything not starting with a single `/` is
 * discarded rather than sanitised, and `//host` is rejected because browsers
 * read it as protocol-relative and it leaves the site.
 */
export function safeNext(next: string | undefined): string {
  if (!next) return '/admin';
  if (!next.startsWith('/') || next.startsWith('//')) return '/admin';
  return next;
}
