import Link from 'next/link';
import { ActionForm, Field, inputClass } from '@/components/admin/action-form';
import { StatusPill } from '@/components/status-pill';
import { formatKickoff } from '@/lib/time';
import { getCurrentSeason } from '@/server/services/competition';
import { listFixtures } from '@/server/services/fixtures';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import { importFixturesAction } from '../actions';

/**
 * The fixture list, and the CSV import that fills it.
 *
 * The import is the reason this screen exists at all: a league of 190 teams is
 * not going to hand-enter a season, and without bulk import the schedule stays
 * in the spreadsheet it is in today no matter how good the rest of this is.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Fixtures' };

export default async function AdminFixturesPage() {
  const league = await getCurrentLeague();
  if (!league) return null;

  const season = await getCurrentSeason(league.id);
  const fixtures = season
    ? await listFixtures(league.id, { seasonId: season.id, limit: 200 })
    : [];

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Fixtures</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {season ? season.name : 'No season is running'} · {fixtures.length} scheduled
      </p>

      <section className="mt-8 rounded-lg border p-5">
        <h2 className="text-lg font-medium">Import a schedule</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Columns: <code className="font-mono text-xs">competition, group, home, away</code> are
          required; <code className="font-mono text-xs">date, time, venue, round, matchday, leg, note</code>{' '}
          are optional. Column order does not matter. Times are league-local.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {/* Both of these are properties of the importer, and saying so is what
              makes an administrator willing to press the button. */}
          A file with any bad row imports nothing, and a pairing that is already
          scheduled is skipped — so re-uploading a corrected file is safe.
        </p>

        <ActionForm action={importFixturesAction} submitLabel="Import" pendingLabel="Reading…">
          {season ? <input type="hidden" name="seasonId" value={season.id} /> : null}
          <Field label="CSV file" name="csv">
            <input id="csv" name="csv" type="file" accept=".csv,text/csv" required className={inputClass} />
          </Field>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="dryRun" defaultChecked />
            <span>Dry run — check the file and write nothing</span>
          </label>
        </ActionForm>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Scheduled</h2>
        {fixtures.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing scheduled yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Every fixture this season</caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">Kickoff</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Match</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Competition</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {fixtures.map((fixture) => (
                  <tr key={fixture.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 whitespace-nowrap tabular-nums text-muted-foreground">
                      {fixture.kickoffAt
                        ? formatKickoff(fixture.kickoffAt, league.timezone, { withZone: false })
                        : 'TBC'}
                    </td>
                    <th scope="row" className="py-2 pr-4 text-left font-medium">
                      <Link href={`/admin/fixtures/${fixture.id}`} className="hover:underline">
                        {fixture.homeTeamName ?? 'TBC'} v {fixture.awayTeamName ?? 'TBC'}
                      </Link>
                    </th>
                    <td className="py-2 pr-4 text-muted-foreground">{fixture.competitionName}</td>
                    <td className="py-2 pr-4">
                      {fixture.result.state === 'CONFIRMED' && fixture.result.scoreline ? (
                        <span className="tabular-nums font-medium">
                          {fixture.result.scoreline.homeScore ?? '–'}–
                          {fixture.result.scoreline.awayScore ?? '–'}
                        </span>
                      ) : fixture.result.state === 'DISPUTED' ? (
                        <StatusPill tone="negative">Disputed</StatusPill>
                      ) : (
                        <StatusPill tone="info">Not reported</StatusPill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
