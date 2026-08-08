import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { EnrolTwoFactor } from '@/components/auth/enrol-two-factor';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill } from '@/components/status-pill';
import { auth } from '@/server/auth';
import { getPrincipal } from '@/server/auth/principal';
import { principalRequiresMfa } from '@/server/authz/roles';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The signed-in user's own page: who the league thinks they are, what they may
 * do, and the second factor.
 *
 * The roles list is shown deliberately. "Why can I not edit this?" is the most
 * common support question a permissioned system generates, and the answer —
 * which roles you hold, in which scope, and whether MFA is satisfied — is
 * otherwise invisible to the person asking.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your account',
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const league = await getCurrentLeague();
  const principal = await getPrincipal();
  if (!principal) redirect('/sign-in?next=/account');

  const session = await auth.api.getSession({ headers: await headers() });
  const needsMfa = principalRequiresMfa(principal);
  const enrolled = session?.user.twoFactorEnabled === true;

  return (
    <main
      id="main"
      className="mx-auto max-w-2xl px-6 py-10"
      style={leagueThemeStyle(league?.theme)}
    >
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league?.shortName ?? league?.slug}
        </Link>
      </nav>

      <header className="mt-1 flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{session?.user.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{session?.user.email}</p>
        </div>
        <SignOutButton />
      </header>

      <section className="mt-8">
        <h2 className="text-lg font-medium">What you can do here</h2>
        {principal.roles.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            You hold no roles in this league, so you can see only what the public can. If that
            is wrong, ask the league office to grant you one.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {principal.roles.map((role, index) => (
              <li key={`${role.role}-${index}`} className="rounded-lg border px-4 py-3">
                <span className="font-medium">{humanRole(role.role)}</span>{' '}
                <span className="text-muted-foreground">
                  {/* The space is a real character, not a margin. A screen
                      reader reads the DOM, where CSS spacing does not exist,
                      and announced this as "League administratoracross the
                      whole league". */}
                  {role.scopeKind === 'ORGANIZATION'
                    ? 'across the whole league'
                    : `for one ${role.scopeKind.toLowerCase()}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-medium">Two-factor authentication</h2>
          {enrolled ? (
            <StatusPill tone="positive">Enrolled</StatusPill>
          ) : needsMfa ? (
            <StatusPill tone="caution">Required for your roles</StatusPill>
          ) : (
            <StatusPill tone="info">Optional</StatusPill>
          )}
        </div>

        {needsMfa && !enrolled ? (
          <p className="mt-3 rounded-lg border border-status-caution/40 bg-status-caution-bg/40 px-4 py-3 text-sm">
            {/* Not a nag. The permission matrix withholds every write from an
                unenrolled admin, so this explains why the buttons do nothing
                rather than leaving them to discover it. */}
            Your roles can move money, overturn suspensions and alter thousands of
            registrations, so a stolen password must not be enough. Until you enrol, you can
            read everything but change nothing.
          </p>
        ) : null}

        <EnrolTwoFactor enrolled={enrolled} />
      </section>
    </main>
  );
}

const ROLE_LABELS: Record<string, string> = {
  PLATFORM_OWNER: 'Platform owner',
  LEAGUE_ADMIN: 'League administrator',
  REGISTRAR: 'Registrar',
  DISCIPLINE_OFFICER: 'Discipline officer',
  REFEREE_ASSIGNOR: 'Referee assignor',
  CLUB_ADMIN: 'Club administrator',
  TEAM_MANAGER: 'Team manager',
  COACH: 'Coach',
  REFEREE: 'Referee',
  PLAYER: 'Player',
};

const humanRole = (role: string): string => ROLE_LABELS[role] ?? role;
