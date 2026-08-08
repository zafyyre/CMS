import Link from 'next/link';
import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill, type StatusTone } from '@/components/status-pill';
import { formatKickoffTime, leagueDateKey } from '@/lib/time';
import { getCurrentSeason } from '@/server/services/competition';
import { type FixtureStatus, type FixtureView, listFixtures } from '@/server/services/fixtures';
import { listClosuresInForce } from '@/server/services/venues';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The schedule.
 *
 * Grouped by the LEAGUE's calendar day rather than by UTC. A 19:00 Saturday
 * kickoff in Vancouver is 02:00 Sunday in UTC, so grouping on the stored
 * instant files half of every weekend under the wrong heading — which is the
 * same daylight-saving family of bug as showing the wrong time, and just as
 * invisible to anyone testing at midday in July.
 *
 * Pages never touch the database. Everything here comes from a service, and
 * every service call goes through `withOrg`.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Schedule' };

const STATUS_TONE: Record<FixtureStatus, StatusTone> = {
  SCHEDULED: 'info',
  PLAYED: 'positive',
  POSTPONED: 'caution',
  CANCELLED: 'negative',
  FORFEITED: 'caution',
  ABANDONED: 'caution',
  AWARDED: 'caution',
};

const STATUS_LABEL: Record<FixtureStatus, string> = {
  SCHEDULED: 'Scheduled',
  PLAYED: 'Played',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled',
  FORFEITED: 'Forfeited',
  ABANDONED: 'Abandoned',
  AWARDED: 'Awarded',
};

export default async function SchedulePage() {
  const league = await getCurrentLeague();
  if (!league) {
    return (
      <main id="main" className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">No league configured</h1>
      </main>
    );
  }

  const season = await getCurrentSeason(league.id);
  const [fixtures, closures] = await Promise.all([
    season ? listFixtures(league.id, { seasonId: season.id }) : Promise.resolve([]),
    listClosuresInForce(league.id),
  ]);

  const days = groupByLeagueDay(fixtures, league.timezone);

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <header className="border-b pb-6">
        <Link href="/" className="text-xs font-medium uppercase tracking-widest text-muted-foreground hover:underline">
          {league.shortName ?? league.slug}
        </Link>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Schedule</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {season ? season.name : 'No season configured'} · all times{' '}
          {/* Naming the zone matters most on the two weekends it changes. */}
          <span className="font-medium">{league.timezone.replace('_', ' ')}</span>
        </p>
      </header>

      {closures.length > 0 ? (
        /**
         * Field closures are site-wide news, not a page you go looking for. On
         * the old site this is buried several clicks down a menu, and between
         * October and March it is the single most useful thing the league
         * publishes.
         */
        <aside className="mt-6 rounded-lg border border-status-caution/40 bg-status-caution-bg/40 p-4">
          <h2 className="text-sm font-medium">
            {closures.length === 1 ? 'One ground is closed' : `${closures.length} grounds are closed`}
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {closures.map((closure) => (
              <li key={closure.id}>
                <span className="font-medium">{closure.venueName}</span>
                <span className="text-muted-foreground"> — {closure.reason}</span>
              </li>
            ))}
          </ul>
          <Link href="/fields" className="mt-2 inline-block text-sm underline">
            All field statuses
          </Link>
        </aside>
      ) : null}

      {days.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">
          No fixtures have been scheduled for this season yet.
        </p>
      ) : (
        days.map(({ key, label, fixtures: dayFixtures }) => (
          <section key={key} className="mt-10">
            <h2 className="text-lg font-medium">{label}</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Fixtures on {label}</caption>
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">Time</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Competition</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Match</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Venue</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {dayFixtures.map((fixture) => (
                    <tr key={fixture.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                        {fixture.kickoffAt
                          ? formatKickoffTime(fixture.kickoffAt, league.timezone)
                          : '—'}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {fixture.competitionName}
                        {fixture.stageGroupName !== fixture.competitionName ? (
                          <span className="block text-xs">{fixture.stageGroupName}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 font-medium">
                        {fixture.homeTeamName ?? 'To be confirmed'}
                        <span className="mx-1.5 font-normal text-muted-foreground">v</span>
                        {fixture.awayTeamName ?? 'To be confirmed'}
                        {fixture.publicNote ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {fixture.publicNote}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {fixture.venueName ?? '—'}
                      </td>
                      <td className="py-2 pr-4">
                        <ResultCell fixture={fixture} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </main>
  );
}

function ResultCell({ fixture }: { fixture: FixtureView }) {
  const { result, status } = fixture;

  if (result.state === 'CONFIRMED' && result.scoreline) {
    const { homeScore, awayScore, homePenalties, awayPenalties } = result.scoreline;
    return (
      <span className="tabular-nums font-medium" title={result.basis}>
        {homeScore ?? '–'}–{awayScore ?? '–'}
        {homePenalties !== null && awayPenalties !== null ? (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            ({homePenalties}–{awayPenalties} pens)
          </span>
        ) : null}
      </span>
    );
  }

  if (result.state === 'DISPUTED') {
    // Shown rather than hidden. A match whose two clubs disagree is exactly
    // the thing a league needs to see, and picking one silently is how it
    // stops being seen.
    return <StatusPill tone="caution">Result disputed</StatusPill>;
  }

  return (
    <StatusPill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusPill>
  );
}

interface ScheduleDay {
  key: string;
  label: string;
  fixtures: FixtureView[];
}

function groupByLeagueDay(fixtures: FixtureView[], timeZone: string): ScheduleDay[] {
  const byDay = new Map<string, FixtureView[]>();
  const undated: FixtureView[] = [];

  for (const fixture of fixtures) {
    if (!fixture.kickoffAt) {
      undated.push(fixture);
      continue;
    }
    const key = leagueDateKey(fixture.kickoffAt, timeZone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(fixture);
    else byDay.set(key, [fixture]);
  }

  const days: ScheduleDay[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, dayFixtures]) => ({
      key,
      label: new Intl.DateTimeFormat('en-CA', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${key}T00:00:00Z`)),
      fixtures: dayFixtures,
    }));

  // Fixtures with no date yet belong at the end of a schedule, not the top.
  if (undated.length > 0) {
    days.push({ key: 'undated', label: 'Date to be confirmed', fixtures: undated });
  }

  return days;
}
