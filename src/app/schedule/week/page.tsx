import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill } from '@/components/status-pill';
import { formatKickoffTime, leagueDateKey, leagueDayBounds } from '@/lib/time';
import { type FixtureView, listFixtures } from '@/server/services/fixtures';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * One week of fixtures.
 *
 * The view a player actually wants — "what is on this weekend" — and the one
 * the old site makes hardest to reach, because everything there is filtered by
 * division first.
 *
 * The week is bounded in the LEAGUE's timezone, not in UTC. That matters twice
 * a year: the week containing a clocks-change is 167 or 169 hours long, and a
 * week computed as "start plus seven times 86,400 seconds" either drops the
 * last hour of fixtures or borrows the first hour of the next week's. Both
 * present as "my match is missing from the schedule".
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'This week',
  description: 'Every fixture this week, in one list.',
};

interface PageProps {
  searchParams: Promise<{ from?: string }>;
}

const DAY_MS = 86_400_000;

export default async function ScheduleWeekPage({ searchParams }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const params = await searchParams;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '')
    ? (params.from as string)
    : leagueDateKey(new Date(), league.timezone);

  const monday = startOfWeek(anchor);
  const nextMonday = shiftDate(monday, 7);
  const previousMonday = shiftDate(monday, -7);

  // Half-open, in the league's own zone, so no fixture is in two weeks or none.
  const { start } = leagueDayBounds(monday, league.timezone);
  const { start: end } = leagueDayBounds(nextMonday, league.timezone);

  const fixtures = await listFixtures(league.id, { from: start, to: end });
  const days = groupByDay(fixtures, league.timezone);

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href="/schedule" className="hover:underline">
          Schedule
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Week of {longDate(monday)}
        </h1>
        <p className="mt-2 text-sm tabular-nums text-muted-foreground">
          {fixtures.length} {fixtures.length === 1 ? 'match' : 'matches'}
        </p>
      </header>

      <nav aria-label="Week" className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link href={`/schedule/week?from=${previousMonday}`} className="underline underline-offset-4">
          ← Previous week
        </Link>
        <Link href="/schedule/week" className="underline underline-offset-4">
          This week
        </Link>
        <Link href={`/schedule/week?from=${nextMonday}`} className="underline underline-offset-4">
          Next week →
        </Link>
      </nav>

      {days.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">
          Nothing is scheduled this week.
        </p>
      ) : (
        days.map((day) => (
          <section key={day.key} className="mt-8">
            <h2 className="text-lg font-medium">{longDate(day.key)}</h2>
            <ul className="mt-3 divide-y rounded-lg border">
              {day.fixtures.map((fixture) => (
                <li
                  key={fixture.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm"
                >
                  <span className="tabular-nums text-muted-foreground">
                    {fixture.kickoffAt
                      ? formatKickoffTime(fixture.kickoffAt, league.timezone)
                      : '—'}
                  </span>
                  <span className="font-medium">
                    {fixture.homeTeamName ?? 'TBC'} v {fixture.awayTeamName ?? 'TBC'}
                  </span>
                  <span className="text-muted-foreground">{fixture.competitionName}</span>
                  {fixture.venueName ? (
                    <span className="text-muted-foreground">{fixture.venueName}</span>
                  ) : null}
                  <span className="ml-auto">
                    {fixture.result.state === 'CONFIRMED' && fixture.result.scoreline ? (
                      <span className="font-medium tabular-nums">
                        {fixture.result.scoreline.homeScore ?? '–'}–
                        {fixture.result.scoreline.awayScore ?? '–'}
                      </span>
                    ) : fixture.result.state === 'DISPUTED' ? (
                      <StatusPill tone="caution">Disputed</StatusPill>
                    ) : fixture.status === 'POSTPONED' ? (
                      <StatusPill tone="caution">Postponed</StatusPill>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}

/** Monday, because that is where a football week starts. */
function startOfWeek(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  // getUTCDay: 0 is Sunday, so Sunday belongs to the week that began six days ago.
  const offset = (date.getUTCDay() + 6) % 7;
  return shiftDate(dateKey, -offset);
}

/**
 * Calendar arithmetic on the date STRING, via UTC.
 *
 * Safe precisely because it never touches a timezone: these are labels for
 * days, and the conversion to instants happens once, in `leagueDayBounds`.
 */
function shiftDate(dateKey: string, days: number): string {
  const shifted = new Date(new Date(`${dateKey}T00:00:00Z`).getTime() + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

const longDate = (dateKey: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dateKey}T00:00:00Z`));

function groupByDay(
  fixtures: FixtureView[],
  timeZone: string,
): { key: string; fixtures: FixtureView[] }[] {
  const byDay = new Map<string, FixtureView[]>();
  for (const fixture of fixtures) {
    if (!fixture.kickoffAt) continue;
    const key = leagueDateKey(fixture.kickoffAt, timeZone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(fixture);
    else byDay.set(key, [fixture]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, dayFixtures]) => ({ key, fixtures: dayFixtures }));
}
