import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, Field, inputClass } from '@/components/admin/action-form';
import { StatusPill } from '@/components/status-pill';
import { formatKickoff, leagueDateKey } from '@/lib/time';
import { sourceLabel } from '@/server/match/result';
import { getFixture, listFixtureChanges } from '@/server/services/fixtures';
import { getMatchReport } from '@/server/services/results';
import { listVenues } from '@/server/services/venues';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import {
  recordEventAction,
  rescheduleFixtureAction,
  retractEventAction,
  setFixtureStatusAction,
  submitResultAction,
} from '../../actions';

/**
 * One match: record the result, log the goals and cards, move it, call it off.
 *
 * Everything on this page is an APPEND. There is no edit button anywhere,
 * because there is nothing to edit — a corrected score supersedes the original
 * and a withdrawn card retracts it, and both the original and the correction
 * stay visible below. That is not a UI choice; the database has no UPDATE
 * policy on these tables, so an edit button would simply not work.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) return { title: 'Fixture' };
  const { id } = await params;
  const fixture = await getFixture(league.id, id);
  if (!fixture) return { title: 'Fixture not found' };
  return { title: `${fixture.homeTeamName ?? 'TBC'} v ${fixture.awayTeamName ?? 'TBC'}` };
}

const STATUSES = [
  'SCHEDULED',
  'PLAYED',
  'POSTPONED',
  'CANCELLED',
  'FORFEITED',
  'ABANDONED',
  'AWARDED',
] as const;

const EVENT_TYPES = [
  'GOAL',
  'OWN_GOAL',
  'PENALTY_SCORED',
  'PENALTY_MISSED',
  'YELLOW_CARD',
  'SECOND_YELLOW_CARD',
  'RED_CARD',
  'SUBSTITUTION',
  'MVP',
  'CLEAN_SHEET',
] as const;

const PERIODS = [
  'FIRST_HALF',
  'SECOND_HALF',
  'EXTRA_TIME_FIRST',
  'EXTRA_TIME_SECOND',
  'PENALTY_SHOOTOUT',
] as const;

export default async function AdminFixturePage({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { id } = await params;
  const fixture = await getFixture(league.id, id);
  if (!fixture) notFound();

  const [report, changes, venues] = await Promise.all([
    getMatchReport(league.id, id),
    listFixtureChanges(league.id, id),
    listVenues(league.id),
  ]);

  const sides = [
    { id: fixture.homeEntryId, name: fixture.homeTeamName ?? 'Home' },
    { id: fixture.awayEntryId, name: fixture.awayTeamName ?? 'Away' },
  ].filter((side): side is { id: string; name: string } => side.id !== null);

  // The submission a correction should point at: the one nothing supersedes.
  const superseded = new Set(report.submissions.map((s) => s.supersedesId).filter(Boolean));
  const current = report.submissions.filter((s) => !superseded.has(s.id)).at(-1);

  return (
    <>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/admin/fixtures" className="hover:underline">
          Fixtures
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {fixture.homeTeamName ?? 'To be confirmed'} v {fixture.awayTeamName ?? 'To be confirmed'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{fixture.competitionName}</span>
          <span>
            {fixture.kickoffAt
              ? formatKickoff(fixture.kickoffAt, league.timezone)
              : 'Date to be confirmed'}
          </span>
          {fixture.venueName ? <span>{fixture.venueName}</span> : null}
          <StatusPill tone={fixture.status === 'PLAYED' ? 'positive' : 'info'}>
            {fixture.status.toLowerCase()}
          </StatusPill>
        </div>
        <p className="mt-2 text-sm">{fixture.result.basis}</p>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section className="rounded-lg border p-5">
          <h2 className="text-lg font-medium">
            {current ? 'Correct the result' : 'Record the result'}
          </h2>
          {current ? (
            <p className="mt-1 text-sm text-muted-foreground">
              This supersedes the {sourceLabel(current.source)} submission of{' '}
              {current.homeScore ?? '–'}–{current.awayScore ?? '–'}. The original stays on the
              record.
            </p>
          ) : null}

          <ActionForm action={submitResultAction} submitLabel="Record result">
            <input type="hidden" name="fixtureId" value={fixture.id} />
            {current ? <input type="hidden" name="supersedesId" value={current.id} /> : null}
            <input type="hidden" name="source" value="LEAGUE_ADMIN" />

            <div className="grid grid-cols-2 gap-3">
              <Field label={`${fixture.homeTeamName ?? 'Home'} goals`} name="homeScore">
                <input id="homeScore" name="homeScore" type="number" min={0} className={inputClass} />
              </Field>
              <Field label={`${fixture.awayTeamName ?? 'Away'} goals`} name="awayScore">
                <input id="awayScore" name="awayScore" type="number" min={0} className={inputClass} />
              </Field>
            </div>

            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="homeForfeit" />
                <span>Home forfeited</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="awayForfeit" />
                <span>Away forfeited</span>
              </label>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              A forfeit takes its scoreline from the rulebook, not from the boxes above.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Home penalties" name="homePenalties">
                <input id="homePenalties" name="homePenalties" type="number" min={0} className={inputClass} />
              </Field>
              <Field label="Away penalties" name="awayPenalties">
                <input id="awayPenalties" name="awayPenalties" type="number" min={0} className={inputClass} />
              </Field>
            </div>

            <Field
              label={current ? 'Reason for the correction (required)' : 'Note'}
              name="reason"
            >
              <input id="reason" name="reason" type="text" className={inputClass} required={!!current} />
            </Field>
          </ActionForm>
        </section>

        <section className="rounded-lg border p-5">
          <h2 className="text-lg font-medium">Move or call off</h2>

          <ActionForm action={rescheduleFixtureAction} submitLabel="Reschedule">
            <input type="hidden" name="fixtureId" value={fixture.id} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="New date" name="date">
                <input
                  id="date"
                  name="date"
                  type="date"
                  className={inputClass}
                  defaultValue={
                    fixture.kickoffAt ? leagueDateKey(fixture.kickoffAt, league.timezone) : ''
                  }
                />
              </Field>
              <Field label="New time" name="time" hint={`Local (${league.timezone})`}>
                <input id="time" name="time" type="time" className={inputClass} />
              </Field>
            </div>
            <Field label="Venue" name="venueId">
              <select id="venueId" name="venueId" defaultValue={fixture.venueId ?? ''} className={inputClass}>
                <option value="">Not set</option>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
                    {venue.closure ? ' (closed)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason (required)" name="reason" hint="Clubs will see this on the record.">
              <input id="reschedule-reason" name="reason" type="text" required className={inputClass} />
            </Field>
          </ActionForm>

          <hr className="my-6" />

          <ActionForm action={setFixtureStatusAction} submitLabel="Change status">
            <input type="hidden" name="fixtureId" value={fixture.id} />
            <Field label="Status" name="status">
              <select id="status" name="status" defaultValue={fixture.status} className={inputClass}>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status.toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" name="clearKickoff" />
              <span>Also clear the date</span>
            </label>
            <Field label="Public note" name="publicNote">
              <input id="publicNote" name="publicNote" type="text" className={inputClass} />
            </Field>
            <Field label="Reason (required)" name="reason">
              <input id="status-reason" name="reason" type="text" required className={inputClass} />
            </Field>
          </ActionForm>
        </section>
      </div>

      <section className="mt-10 rounded-lg border p-5">
        <h2 className="text-lg font-medium">Match events</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Goals and cards feed the goalscorer chart and, from Phase 11, discipline. A shootout
          conversion is recorded with period <em>penalty shootout</em> so it never counts as a goal.
        </p>

        <ActionForm action={recordEventAction} submitLabel="Add event" className="mt-4">
          <input type="hidden" name="fixtureId" value={fixture.id} />
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Type" name="type">
              <select id="type" name="type" className={inputClass}>
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type.toLowerCase().replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Team" name="editionEntryId">
              <select id="editionEntryId" name="editionEntryId" className={inputClass}>
                <option value="">Neither</option>
                {sides.map((side) => (
                  <option key={side.id} value={side.id}>
                    {side.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Period" name="period">
              <select id="period" name="period" className={inputClass}>
                {PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {period.toLowerCase().replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Minute" name="minute">
              <input id="minute" name="minute" type="number" min={0} max={200} className={inputClass} />
            </Field>
          </div>
        </ActionForm>

        {report.events.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-6 divide-y rounded-lg border">
            {report.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-3 px-4 py-3 text-sm">
                <span className="tabular-nums text-muted-foreground">
                  {event.minute !== null ? `${event.minute}'` : '—'}
                </span>
                <span className="font-medium">{event.type.toLowerCase().replace(/_/g, ' ')}</span>
                <span className="text-muted-foreground">
                  {sides.find((s) => s.id === event.editionEntryId)?.name ?? ''}
                </span>
                <details className="ml-auto">
                  <summary className="cursor-pointer text-xs underline">Withdraw</summary>
                  <ActionForm action={retractEventAction} submitLabel="Withdraw" destructive>
                    <input type="hidden" name="fixtureId" value={fixture.id} />
                    <input type="hidden" name="eventId" value={event.id} />
                    <Field label="Reason (required)" name="reason">
                      <input
                        id={`retract-${event.id}`}
                        name="reason"
                        type="text"
                        required
                        className={inputClass}
                      />
                    </Field>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-medium">Everything reported</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Superseded submissions are kept. &ldquo;What did they originally say&rdquo; is the
            first question in any protest.
          </p>
          <ul className="mt-3 divide-y rounded-lg border text-sm">
            {report.submissions.length === 0 ? (
              <li className="px-4 py-3 text-muted-foreground">Nothing yet.</li>
            ) : (
              report.submissions.map((submission) => (
                <li key={submission.id} className="px-4 py-3">
                  <span className="font-medium tabular-nums">
                    {submission.homeScore ?? '–'}–{submission.awayScore ?? '–'}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {sourceLabel(submission.source)}
                  </span>
                  {superseded.has(submission.id) ? (
                    <span className="ml-2 text-xs uppercase tracking-wide text-muted-foreground">
                      superseded
                    </span>
                  ) : null}
                  {submission.reason ? (
                    <p className="mt-1 text-xs text-muted-foreground">{submission.reason}</p>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-medium">Every change to this fixture</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Append-only in PostgreSQL. Nobody can edit or remove a row here.
          </p>
          <ul className="mt-3 divide-y rounded-lg border text-sm">
            {changes.map((change) => (
              <li key={change.id} className="px-4 py-3">
                <span className="font-medium">{change.kind.toLowerCase().replace(/_/g, ' ')}</span>
                {change.previousKickoffAt && change.newKickoffAt ? (
                  <span className="ml-2 tabular-nums text-muted-foreground">
                    {formatKickoff(change.previousKickoffAt, league.timezone, { withZone: false })} →{' '}
                    {formatKickoff(change.newKickoffAt, league.timezone, { withZone: false })}
                  </span>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">{change.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
