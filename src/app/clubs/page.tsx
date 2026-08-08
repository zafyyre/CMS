import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { listClubs } from '@/server/services/competition';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The club index — the entry point to every club's own page.
 *
 * Sorted by name and shown in full rather than paginated: a league has of the
 * order of forty clubs, and a search box in front of forty items is a barrier
 * rather than a feature.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Clubs',
  description: 'Every club in the league.',
};

export default async function ClubsPage() {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const clubs = await listClubs(league.id);

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Clubs</h1>
        <p className="mt-2 text-sm tabular-nums text-muted-foreground">
          {clubs.length} clubs, {clubs.reduce((sum, c) => sum + c.teamCount, 0)} sides
        </p>
      </header>

      <ul className="mt-8 grid gap-2 sm:grid-cols-2">
        {clubs.map((club) => (
          <li key={club.id} className="rounded-lg border px-4 py-3">
            <Link href={`/clubs/${club.slug}`} className="font-medium hover:underline">
              {club.name}
            </Link>
            <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">
              {club.teamCount} {club.teamCount === 1 ? 'side' : 'sides'}
              {club.foundedYear ? ` · founded ${club.foundedYear}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
