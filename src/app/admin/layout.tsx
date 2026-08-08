import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill } from '@/components/status-pill';
import { auth } from '@/server/auth';
import { getPrincipal } from '@/server/auth/principal';
import { can } from '@/server/authz/can';
import { principalRequiresMfa } from '@/server/authz/roles';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The gate in front of every admin screen.
 *
 * Worth being explicit about what this layout is and is NOT. It is a
 * convenience: it stops a signed-out visitor seeing a page full of empty
 * forms, and it hides links to things the caller cannot do. It is emphatically
 * NOT the security boundary — a layout runs only when Next decides to render
 * a page, and a Server Action reached by a direct POST never renders anything.
 *
 * The boundary is three layers deeper: every action re-establishes the
 * principal, every service consults the permission matrix, and PostgreSQL
 * scopes the query to the league regardless. This is the doormat, not the lock.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const principal = await getPrincipal();
  if (!principal) redirect('/sign-in?next=/admin');

  const league = await getCurrentLeague();
  const session = await auth.api.getSession({ headers: await headers() });

  /**
   * Which sections this person's ROLES cover — deliberately ignoring MFA.
   *
   * `enforceMfa: false` is the important part. An administrator who has not yet
   * enrolled a second factor genuinely cannot write anything: the matrix
   * withholds every mutation, and the services enforce that. But hiding the
   * screens from them as well produced a page that said "every button below
   * will refuse" above no buttons at all, and gave them nowhere to see what
   * they were locked out of or why.
   *
   * So navigation asks "would this role ever be allowed here?" and the banner
   * explains the rest. Nothing is loosened: every write still passes through
   * `assertCan` with MFA enforced.
   */
  const readOnly = { enforceMfa: false };
  const canManageFixtures = can(principal, 'update', { type: 'fixture' }, readOnly);
  const canManageVenues = can(principal, 'update', { type: 'venue' }, readOnly);
  const canImport = can(principal, 'create', { type: 'club' }, readOnly);
  const canDoAnything = canManageFixtures || canManageVenues || canImport;

  const mfaOutstanding = principalRequiresMfa(principal) && !session?.user.twoFactorEnabled;

  return (
    <div style={leagueThemeStyle(league?.theme)}>
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/" className="text-xs font-medium uppercase tracking-widest text-muted-foreground hover:underline">
            {league?.shortName ?? league?.slug}
          </Link>
          <nav aria-label="Admin" className="flex flex-wrap gap-4 text-sm">
            <Link href="/admin" className="hover:underline">
              Overview
            </Link>
            {canManageFixtures ? (
              <Link href="/admin/fixtures" className="hover:underline">
                Fixtures
              </Link>
            ) : null}
            {canManageVenues ? (
              <Link href="/admin/venues" className="hover:underline">
                Venues
              </Link>
            ) : null}
            {canImport ? (
              <Link href="/admin/import" className="hover:underline">
                Import
              </Link>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <Link href="/account" className="text-sm hover:underline">
              {session?.user.name ?? 'Account'}
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      {mfaOutstanding ? (
        <div className="border-b border-status-caution/40 bg-status-caution-bg/40">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-6 py-3 text-sm">
            <StatusPill tone="caution">Second factor not enrolled</StatusPill>
            <span>
              Your roles cannot write anything until you enrol. Every button below will refuse.
            </span>
            <Link href="/account" className="underline">
              Enrol now
            </Link>
          </div>
        </div>
      ) : null}

      <main id="main" className="mx-auto max-w-5xl px-6 py-8">
        {canDoAnything ? (
          children
        ) : (
          <div className="rounded-lg border p-6">
            <h1 className="text-lg font-medium">Nothing to administer</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You are signed in, but you hold no role in this league that grants access to these
              screens. Your{' '}
              <Link href="/account" className="underline">
                account page
              </Link>{' '}
              lists what you do hold.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
