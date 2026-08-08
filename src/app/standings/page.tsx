import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { StandingsTable } from '@/components/standings-table';
import { StatusPill } from '@/components/status-pill';
import { getCurrentSeason, listCompetitions } from '@/server/services/competition';
import { getEditionBySlugs, listSeasons } from '@/server/services/directory';
import { listEditionStandings } from '@/server/services/standings';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The league table.
 *
 * This is the page. Several thousand people open it within the same twenty
 * minutes on a Sunday evening, on phones, at the side of a pitch — so it reads
 * a stored snapshot rather than deriving ninety fixtures per request, and it
 * shows something before asking anything.
 *
 * The old site's model was: choose a registration year, then a division from a
 * flat list of thirty items, then a report type, then press a button. Here the
 * current season and the top division are simply assumed, because the data
 * knows which they are, and the filters are links you can share.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Standings',
  description: 'League tables, updated as results are confirmed.',
};

interface PageProps {
  searchParams: Promise<{ season?: string; competition?: string }>;
}

export default async function StandingsPage({ searchParams }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const params = await searchParams;
  const seasons = await listSeasons(league.id);
  const current = await getCurrentSeason(league.id);

  const season = params.season
    ? seasons.find((s) => s.slug === params.season)
    : (seasons.find((s) => s.id === current?.id) ?? seasons[seasons.length - 1]);

  if (!season) {
    return (
      <Shell league={league}>
        <p className="mt-10 text-sm text-muted-foreground">
          No seasons have been set up yet.
        </p>
      </Shell>
    );
  }

  const competitions = await listCompetitions(league.id, season.id);
  const leagueCompetitions = competitions.filter((c) => !c.isCup);

  const selected = params.competition
    ? await getEditionBySlugs(league.id, season.slug, params.competition)
    : null;

  // Default to the top of the pyramid rather than to nothing.
  const editionId = selected?.editionId ?? leagueCompetitions[0]?.editionId;
  const tables = editionId ? await listEditionStandings(league.id, editionId) : [];
  const activeCompetition = competitions.find((c) => c.editionId === editionId);

  return (
    <Shell league={league}>
      <nav aria-label="Season" className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Season
        </h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {seasons.map((s) => (
            <li key={s.id}>
              <Link
                href={`/standings?season=${s.slug}`}
                aria-current={s.id === season.id ? 'page' : undefined}
                className={
                  s.id === season.id
                    ? 'inline-block rounded-full border border-foreground px-3 py-1 text-sm font-medium'
                    : 'inline-block rounded-full border px-3 py-1 text-sm text-muted-foreground hover:border-foreground hover:text-foreground'
                }
              >
                {s.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <nav aria-label="Competition" className="mt-6">
        <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Competition
        </h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {competitions.map((c) => (
            <li key={c.editionId}>
              <Link
                href={`/standings?season=${season.slug}&competition=${c.slug}`}
                aria-current={c.editionId === editionId ? 'page' : undefined}
                className={
                  c.editionId === editionId
                    ? 'inline-block rounded-full border border-foreground px-3 py-1 text-sm font-medium'
                    : 'inline-block rounded-full border px-3 py-1 text-sm text-muted-foreground hover:border-foreground hover:text-foreground'
                }
              >
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tables.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">
          {activeCompetition
            ? `No table has been computed for ${activeCompetition.name} yet. Tables appear as soon as the first result is confirmed.`
            : 'No competitions are running this season.'}
        </p>
      ) : (
        tables.map((table) => (
          <section key={table.stageGroupId} className="mt-10">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-medium">
                {table.stageGroupName}
                {table.stageName !== table.stageGroupName ? (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {/* The separator is inside the accessible name on purpose.
                        Without it a screen reader announces the heading as
                        "Premier DivisionRegular Season" — the two strings are
                        adjacent in the DOM and CSS margins do not separate
                        text for assistive technology. */}
                    {'— '}
                    {table.stageName}
                  </span>
                ) : null}
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {table.fixturesDisputed > 0 ? (
                  <StatusPill tone="caution">
                    {table.fixturesDisputed} disputed result
                    {table.fixturesDisputed === 1 ? '' : 's'} not counted
                  </StatusPill>
                ) : null}
                {table.requiresManualResolution ? (
                  <StatusPill tone="caution">Order provisional</StatusPill>
                ) : null}
                <span className="tabular-nums">
                  {table.fixturesCounted} played · {table.fixturesOutstanding} to come
                </span>
              </div>
            </div>

            <StandingsTable table={table} />
          </section>
        ))
      )}
    </Shell>
  );
}

function Shell({
  league,
  children,
}: {
  league: NonNullable<Awaited<ReturnType<typeof getCurrentLeague>>>;
  children: React.ReactNode;
}) {
  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <header className="border-b pb-6">
        <Link
          href="/"
          className="text-xs font-medium uppercase tracking-widest text-muted-foreground hover:underline"
        >
          {league.shortName ?? league.slug}
        </Link>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Standings</h1>
      </header>
      {children}
    </main>
  );
}
