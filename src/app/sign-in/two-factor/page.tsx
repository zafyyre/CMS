import { TwoFactorForm } from '@/components/auth/two-factor-form';
import { leagueThemeStyle } from '@/components/league-theme';
import { safeNext } from '@/lib/safe-next';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The second factor.
 *
 * Reached only when better-auth has verified a password but is WITHHOLDING the
 * session until a TOTP code arrives. That withholding is what makes
 * `session.user.twoFactorEnabled` mean "this factor was satisfied" on the
 * server — which is precisely the assumption `getPrincipal()` encodes as
 * `mfaSatisfied`, and therefore what the permission matrix gates admin writes
 * on. If this page were skippable, that assumption would be false everywhere.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Two-factor authentication',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function TwoFactorPage({ searchParams }: PageProps) {
  const league = await getCurrentLeague();
  const { next } = await searchParams;
  const destination = safeNext(next);

  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-sm flex-col justify-center px-6 py-16"
      style={leagueThemeStyle(league?.theme)}
    >
      <h1 className="text-2xl font-semibold tracking-tight">Two-factor authentication</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Enter the six-digit code from your authenticator app.
      </p>

      <TwoFactorForm next={destination} />
    </main>
  );
}
