import Link from 'next/link';
import { ActionForm } from '@/components/admin/action-form';
import { StatusPill } from '@/components/status-pill';
import { getPrincipal } from '@/server/auth/principal';
import { getCurrentSeason, listCompetitions } from '@/server/services/competition';
import { listFixtures } from '@/server/services/fixtures';
import { listEditionStandings } from '@/server/services/standings';
import { listClosuresInForce } from '@/server/services/venues';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import { recomputeStandingsAction } from './actions';

/**
 * The administrator's overview: what needs attention, rather than what exists.
 *
 * Three things belong at the top of a league official's Monday morning, and
 * they are the three things the old system makes you go looking for:
 * results that have not arrived, results the two clubs disagree about, and
 * grounds that are shut.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview' };

export default async function AdminOverviewPage() {
  const league = await getCurrentLeague();
  const principal = await getPrincipal();
  if (!league || !principal) return null;

  const season = await getCurrentSeason(league.id);
  const [fixtures, closures, competitions] = await Promise.all([
    season ? listFixtures(league.id, { seasonId: season.id }) : Promise.resolve([]),
    listClosuresInForce(league.id),
    season ? listCompetitions(league.id, season.id) : Promise.resolve([]),
  ]);

  const now = new Date();
  const disputed = fixtures.filter((f) => f.result.state === 'DISPUTED');
  const awaitingResult = fixtures.filter(
    (f) =>
      f.result.state === 'NONE' &&
      f.kickoffAt !== null &&
      f.kickoffAt < now &&
      f.status !== 'POSTPONED' &&
      f.status !== 'CANCELLED',
  );

  // Standings that are provisional pending a human — a drawing of lots.
  const tables = (
    await Promise.all(competitions.map((c) => listEditionStandings(league.id, c.editionId)))
  ).flat();
  const provisional = tables.filter((t) => t.requiresManualResolution);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {season ? season.name : 'No season is running'}
      </p>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Card
          label="Results outstanding"
          value={awaitingResult.length}
          tone={awaitingResult.length > 0 ? 'caution' : 'positive'}
        />
        <Card
          label="Results disputed"
          value={disputed.length}
          tone={disputed.length > 0 ? 'negative' : 'positive'}
        />
        <Card
          label="Grounds closed"
          value={closures.length}
          tone={closures.length > 0 ? 'caution' : 'positive'}
        />
      </section>

      {awaitingResult.length > 0 ? (
        <Section
          title="Played, but no result reported"
          hint="Kickoff has passed and nobody has told us the score."
        >
          <ul className="divide-y rounded-lg border">
            {awaitingResult.slice(0, 20).map((fixture) => (
              <li key={fixture.id} className="px-4 py-3 text-sm">
                <Link href={`/admin/fixtures/${fixture.id}`} className="font-medium hover:underline">
                  {fixture.homeTeamName ?? 'TBC'} v {fixture.awayTeamName ?? 'TBC'}
                </Link>
                <span className="ml-2 text-muted-foreground">{fixture.competitionName}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {disputed.length > 0 ? (
        <Section
          title="The two clubs disagree"
          hint="Both reported, and they do not match. These are excluded from the table until somebody rules."
        >
          <ul className="divide-y rounded-lg border">
            {disputed.map((fixture) => (
              <li key={fixture.id} className="px-4 py-3 text-sm">
                <Link href={`/admin/fixtures/${fixture.id}`} className="font-medium hover:underline">
                  {fixture.homeTeamName ?? 'TBC'} v {fixture.awayTeamName ?? 'TBC'}
                </Link>
                <p className="mt-1 text-muted-foreground">{fixture.result.basis}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {provisional.length > 0 ? (
        <Section
          title="Tables needing a drawing of lots"
          hint="The rulebook ran out. The order shown publicly is marked provisional until somebody draws."
        >
          <ul className="divide-y rounded-lg border">
            {provisional.map((table) => (
              <li key={table.stageGroupId} className="px-4 py-3 text-sm">
                {table.stageGroupName}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Recompute a table" hint="Normally automatic. Use this after changing rules or a points deduction.">
        <div className="grid gap-3 sm:grid-cols-2">
          {tables.map((table) => (
            <div key={table.stageGroupId} className="rounded-lg border p-4">
              <p className="text-sm font-medium">{table.stageGroupName}</p>
              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                {table.fixturesCounted} counted · {table.fixturesOutstanding} to play
              </p>
              <ActionForm action={recomputeStandingsAction} submitLabel="Recompute">
                <input type="hidden" name="stageGroupId" value={table.stageGroupId} />
              </ActionForm>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function Card({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'positive' | 'caution' | 'negative';
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2">
        <StatusPill tone={value === 0 ? 'positive' : tone}>
          {value === 0 ? 'Nothing outstanding' : 'Needs attention'}
        </StatusPill>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-medium">{title}</h2>
      {hint ? <p className="mt-1 mb-3 text-sm text-muted-foreground">{hint}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}
