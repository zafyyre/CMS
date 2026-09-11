import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { serializeJsonLd } from '@/lib/json-ld';
import { getClubBySlug } from '@/server/services/directory';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * A page for THIS club.
 *
 * The old site has no such thing — it can render a club's fixtures inside a
 * report, but there is no address for the club itself, so nothing about it can
 * be linked to, shared or found by search. That is the difference between a
 * report generator and a website.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) return { title: 'Club' };
  const { slug } = await params;
  const club = await getClubBySlug(league.id, slug);
  if (!club) return { title: 'Club not found' };

  return {
    title: club.name,
    description: `${club.name} — teams, competitions and fixtures in the ${league.name}.`,
  };
}

export default async function ClubPage({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { slug } = await params;
  const club = await getClubBySlug(league.id, slug);
  if (!club) notFound();

  /**
   * Structured data, so a search for the club name finds this page rather than
   * a PDF. `SportsOrganization` is the correct type; `sport` is what
   * disambiguates it from every other club with a similar name.
   */
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsOrganization',
    name: club.name,
    sport: 'Soccer',
    ...(club.foundedYear ? { foundingDate: String(club.foundedYear) } : {}),
    memberOf: { '@type': 'SportsOrganization', name: league.name },
    subOrganization: club.teams.map((team) => ({
      '@type': 'SportsTeam',
      name: team.name,
      sport: 'Soccer',
    })),
  };

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <script
        type="application/ld+json"
        // Escaped for a script context, NOT plain JSON.stringify — a club name
        // containing "</script>" would otherwise close this tag and execute.
        // Names come from the importers, so that is reachable input.
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href="/clubs" className="hover:underline">
          Clubs
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">{club.name}</h1>
        <div className="mt-2 flex flex-wrap gap-3 text-sm text-muted-foreground">
          {club.foundedYear ? <span className="tabular-nums">Founded {club.foundedYear}</span> : null}
          <span className="tabular-nums">
            {club.teams.length} {club.teams.length === 1 ? 'side' : 'sides'}
          </span>
        </div>
      </header>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Teams</h2>
        {club.teams.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This club has no teams registered.
          </p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {club.teams.map((team) => (
              <li key={team.id} className="rounded-lg border px-4 py-3">
                <Link href={`/teams/${team.slug}`} className="font-medium hover:underline">
                  {team.name}
                </Link>
                {team.designation ? (
                  <span className="ml-2 text-xs text-muted-foreground">{team.designation}</span>
                ) : null}
                {team.competitions.length > 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {team.competitions.join(' · ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
