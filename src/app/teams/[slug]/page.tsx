import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill } from '@/components/status-pill';
import { serializeJsonLd } from '@/lib/json-ld';
import { formatKickoff } from '@/lib/time';
import { getTeamBySlug } from '@/server/services/directory';
import { listFixtures } from '@/server/services/fixtures';
import { getStandings } from '@/server/services/standings';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * A page for THIS team: where they are in the table, what they have played,
 * and what is coming.
 *
 * It also carries the calendar subscription. A fixtures list that a player has
 * to remember to check is a fixtures list they will miss a change to; an ICS
 * feed puts every reschedule into their phone automatically. It is cheap to
 * build and disproportionately loved, which is why it is on the team page and
 * not buried in a settings screen.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) return { title: 'Team' };
  const { slug } = await params;
  const team = await getTeamBySlug(league.id, slug);
  if (!team) return { title: 'Team not found' };

  return {
    title: team.name,
    description: `${team.name} — fixtures, results and league position in the ${league.name}.`,
  };
}

export default async function TeamPage({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { slug } = await params;
  const team = await getTeamBySlug(league.id, slug);
  if (!team) notFound();

  const currentEntry = team.entries[team.entries.length - 1];

  const [fixtures, standing] = await Promise.all([
    currentEntry
      ? listFixtures(league.id, { entryId: currentEntry.entryId })
      : Promise.resolve([]),
    currentEntry?.stageGroupIds[0]
      ? getStandings(league.id, currentEntry.stageGroupIds[0])
      : Promise.resolve(null),
  ]);

  const ourRow = standing?.rows.find((row) => row.entryId === currentEntry?.entryId);
  const now = new Date();
  const upcoming = fixtures.filter((f) => !f.kickoffAt || f.kickoffAt >= now);
  const past = fixtures.filter((f) => f.kickoffAt && f.kickoffAt < now).reverse();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsTeam',
    name: team.name,
    sport: 'Soccer',
    parentOrganization: { '@type': 'SportsOrganization', name: team.club.name },
    memberOf: { '@type': 'SportsOrganization', name: league.name },
  };

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <script
        type="application/ld+json"
        // Escaped for a script context. See src/lib/json-ld.ts — plain
        // JSON.stringify leaves "</script>" intact and is an XSS here.
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/clubs/${team.club.slug}`} className="hover:underline">
          {team.club.name}
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">{team.name}</h1>
        {currentEntry ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {currentEntry.competitionName} · {currentEntry.seasonName}
          </p>
        ) : null}

        <p className="mt-4">
          <a
            href={`/api/ics/team/${team.id}.ics`}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:border-foreground"
          >
            Subscribe to fixtures
          </a>
          <span className="ml-2 text-xs text-muted-foreground">
            Adds every match to your calendar, and updates when one moves.
          </span>
        </p>
      </header>

      {ourRow && standing ? (
        <section className="mt-8">
          <h2 className="text-lg font-medium">In the table</h2>
          <div className="mt-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Stat label="Position" value={ourRow.position} />
              <Stat label="Played" value={ourRow.played} />
              <Stat label="Won" value={ourRow.won} />
              <Stat label="Drawn" value={ourRow.drawn} />
              <Stat label="Lost" value={ourRow.lost} />
              <Stat
                label="Goal difference"
                value={ourRow.goalDifference > 0 ? `+${ourRow.goalDifference}` : ourRow.goalDifference}
              />
              <Stat label="Points" value={ourRow.points} />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{ourRow.basis}</p>
            <Link
              href={`/standings?season=${currentEntry?.seasonSlug}&competition=${currentEntry?.competitionSlug}`}
              className="mt-2 inline-block text-sm underline"
            >
              Full table
            </Link>
          </div>
        </section>
      ) : null}

      <FixtureList
        title="Upcoming"
        fixtures={upcoming}
        timezone={league.timezone}
        teamEntryId={currentEntry?.entryId}
        emptyMessage="No fixtures scheduled."
      />
      <FixtureList
        title="Results"
        fixtures={past}
        timezone={league.timezone}
        teamEntryId={currentEntry?.entryId}
        emptyMessage="No matches played yet."
      />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function FixtureList({
  title,
  fixtures,
  timezone,
  teamEntryId,
  emptyMessage,
}: {
  title: string;
  fixtures: Awaited<ReturnType<typeof listFixtures>>;
  timezone: string;
  teamEntryId: string | undefined;
  emptyMessage: string;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-medium">{title}</h2>
      {fixtures.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="mt-3 divide-y rounded-lg border">
          {fixtures.map((fixture) => {
            const atHome = fixture.homeEntryId === teamEntryId;
            const opponent = atHome ? fixture.awayTeamName : fixture.homeTeamName;
            const scoreline = fixture.result.scoreline;

            return (
              <li key={fixture.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                <span className="text-sm text-muted-foreground">
                  {/* Home and away spelled out, not colour-coded or implied by
                      column order — both fail on a narrow screen. */}
                  {atHome ? 'Home' : 'Away'}
                </span>
                <span className="font-medium">{opponent ?? 'To be confirmed'}</span>
                <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                  {fixture.kickoffAt ? formatKickoff(fixture.kickoffAt, timezone) : 'Date to be confirmed'}
                </span>
                {scoreline && fixture.result.state === 'CONFIRMED' ? (
                  <span className="w-full text-sm font-medium tabular-nums sm:w-auto">
                    {atHome
                      ? `${scoreline.homeScore ?? '–'}–${scoreline.awayScore ?? '–'}`
                      : `${scoreline.awayScore ?? '–'}–${scoreline.homeScore ?? '–'}`}
                  </span>
                ) : fixture.result.state === 'DISPUTED' ? (
                  <StatusPill tone="caution">Result disputed</StatusPill>
                ) : null}
                {fixture.venueName ? (
                  <span className="w-full text-xs text-muted-foreground">{fixture.venueName}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
