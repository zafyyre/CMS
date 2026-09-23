'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getPrincipal } from '@/server/auth/principal';
import { ForbiddenError } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import { importFixturesFromCsv } from '@/server/services/fixture-import';
import {
  rescheduleFixture,
  setFixtureStatus,
  type FixtureStatus,
} from '@/server/services/fixtures';
import {
  confirmMatch,
  promoteImport,
  rejectMatch,
  resolveImport,
  stageImport,
} from '@/server/services/import';
import { recordMatchEvents, retractMatchEvent, submitResult } from '@/server/services/results';
import { recomputeStandings } from '@/server/services/standings';
import { closeVenue, createVenue, reopenVenue } from '@/server/services/venues';
import type { MatchEventType, MatchPeriod } from '@/server/match/events';
import type { MatchReportSource } from '@/server/match/result';

/**
 * Every mutation the admin screens can perform.
 *
 * ── WHY EACH ONE RE-CHECKS ──────────────────────────────────────────────────
 * A Server Action is a POST endpoint. It is reachable directly, with a crafted
 * body, by anyone who knows its id — the form around it is a convenience, not
 * a boundary. So authentication is re-established here on every call, and the
 * SERVICE re-checks authorization through the permission matrix, and RLS
 * re-scopes the query to the caller's league. Three independent checks, none of
 * which trusts the screen that called it.
 *
 * These functions are deliberately thin. Nothing in this file decides
 * anything: no validation beyond parsing the form, no writes that do not go
 * through a service. The moment an action starts making decisions is the moment
 * the authorization in the service layer stops being the whole story.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Signed in, or sent to sign in — never silently ignored. */
async function requireAdmin(next: string): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return principal;
}

/**
 * Turn a thrown error into something a human can act on.
 *
 * `ForbiddenError` gets its own message because "you cannot do this" and
 * "that did not work" send an administrator to two completely different places
 * — the former to the league office for a role, the latter to the form.
 */
function explain(error: unknown): ActionResult {
  if (error instanceof ForbiddenError) {
    return {
      ok: false,
      message: `${error.message}. If you believe you should be able to, check that your second factor is enrolled on your account page.`,
    };
  }
  return { ok: false, message: error instanceof Error ? error.message : 'Something went wrong.' };
}

const text = (form: FormData, field: string): string => String(form.get(field) ?? '').trim();
const optionalText = (form: FormData, field: string): string | undefined =>
  text(form, field) || undefined;
const optionalInt = (form: FormData, field: string): number | undefined => {
  const raw = text(form, field);
  return raw === '' ? undefined : Number(raw);
};

// --- results -----------------------------------------------------------------

export async function submitResultAction(form: FormData): Promise<ActionResult> {
  const fixtureId = text(form, 'fixtureId');
  const principal = await requireAdmin(`/admin/fixtures/${fixtureId}`);

  try {
    await submitResult(principal, {
      fixtureId,
      source: text(form, 'source') as MatchReportSource,
      homeScore: optionalInt(form, 'homeScore') ?? null,
      awayScore: optionalInt(form, 'awayScore') ?? null,
      homeForfeit: form.get('homeForfeit') === 'on',
      awayForfeit: form.get('awayForfeit') === 'on',
      homePenalties: optionalInt(form, 'homePenalties') ?? null,
      awayPenalties: optionalInt(form, 'awayPenalties') ?? null,
      supersedesId: optionalText(form, 'supersedesId') ?? null,
      reason: optionalText(form, 'reason') ?? null,
    });
  } catch (error) {
    return explain(error);
  }

  // The standings recompute happens inside submitResult, in the same
  // transaction, so both pages are stale the moment it returns.
  revalidatePath(`/admin/fixtures/${fixtureId}`);
  revalidatePath('/standings');
  revalidatePath('/schedule');
  return { ok: true, message: 'Result recorded. The table has been recomputed.' };
}

export async function recordEventAction(form: FormData): Promise<ActionResult> {
  const fixtureId = text(form, 'fixtureId');
  const principal = await requireAdmin(`/admin/fixtures/${fixtureId}`);

  try {
    await recordMatchEvents(principal, fixtureId, [
      {
        type: text(form, 'type') as MatchEventType,
        period: (optionalText(form, 'period') ?? 'FIRST_HALF') as MatchPeriod,
        minute: optionalInt(form, 'minute') ?? null,
        editionEntryId: optionalText(form, 'editionEntryId') ?? null,
        personId: optionalText(form, 'personId') ?? null,
        note: optionalText(form, 'note') ?? null,
      },
    ]);
  } catch (error) {
    return explain(error);
  }

  revalidatePath(`/admin/fixtures/${fixtureId}`);
  return { ok: true, message: 'Event recorded.' };
}

export async function retractEventAction(form: FormData): Promise<ActionResult> {
  const fixtureId = text(form, 'fixtureId');
  const principal = await requireAdmin(`/admin/fixtures/${fixtureId}`);

  try {
    await retractMatchEvent(principal, text(form, 'eventId'), text(form, 'reason'));
  } catch (error) {
    return explain(error);
  }

  revalidatePath(`/admin/fixtures/${fixtureId}`);
  return { ok: true, message: 'Event withdrawn. The original is still on the record.' };
}

// --- fixtures ----------------------------------------------------------------

export async function rescheduleFixtureAction(form: FormData): Promise<ActionResult> {
  const fixtureId = text(form, 'fixtureId');
  const principal = await requireAdmin(`/admin/fixtures/${fixtureId}`);

  const date = text(form, 'date');
  const time = text(form, 'time');

  try {
    await rescheduleFixture(principal, {
      fixtureId,
      // Both or neither: a date with no time is not a kickoff.
      kickoffLocal: date && time ? `${date}T${time}` : date || time ? undefined : null,
      venueId: form.has('venueId') ? optionalText(form, 'venueId') ?? null : undefined,
      reason: text(form, 'reason'),
    });
  } catch (error) {
    return explain(error);
  }

  revalidatePath(`/admin/fixtures/${fixtureId}`);
  revalidatePath('/schedule');
  return { ok: true, message: 'Fixture moved, and the change is on its record.' };
}

export async function setFixtureStatusAction(form: FormData): Promise<ActionResult> {
  const fixtureId = text(form, 'fixtureId');
  const principal = await requireAdmin(`/admin/fixtures/${fixtureId}`);

  try {
    await setFixtureStatus(principal, {
      fixtureId,
      status: text(form, 'status') as FixtureStatus,
      reason: text(form, 'reason'),
      clearKickoff: form.get('clearKickoff') === 'on',
      publicNote: optionalText(form, 'publicNote') ?? null,
    });
  } catch (error) {
    return explain(error);
  }

  revalidatePath(`/admin/fixtures/${fixtureId}`);
  revalidatePath('/schedule');
  return { ok: true, message: 'Status changed.' };
}

export async function importFixturesAction(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin('/admin/fixtures');
  const file = form.get('csv');

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose a CSV file to import.' };
  }

  const dryRun = form.get('dryRun') === 'on';

  try {
    const report = await importFixturesFromCsv(principal, await file.text(), {
      dryRun,
      seasonId: optionalText(form, 'seasonId'),
    });

    revalidatePath('/admin/fixtures');
    revalidatePath('/schedule');

    const lines = report.rows
      .filter((row) => row.outcome !== 'CREATED' || report.dryRun)
      .slice(0, 25)
      .map((row) => `line ${row.line}: ${row.message}`);

    return {
      ok: report.errors === 0,
      message:
        `${dryRun ? 'Dry run. ' : ''}${report.created} to create, ${report.skipped} already present, ${report.errors} problems.` +
        (lines.length > 0 ? `\n${lines.join('\n')}` : ''),
    };
  } catch (error) {
    return explain(error);
  }
}

// --- venues ------------------------------------------------------------------

export async function createVenueAction(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin('/admin/venues');

  try {
    await createVenue(principal, {
      name: text(form, 'name'),
      surface: (optionalText(form, 'surface') ?? 'UNKNOWN') as
        | 'GRASS'
        | 'ARTIFICIAL_TURF'
        | 'INDOOR'
        | 'UNKNOWN',
      isFloodlit: form.get('isFloodlit') === 'on',
      address: optionalText(form, 'address') ?? null,
    });
  } catch (error) {
    return explain(error);
  }

  revalidatePath('/admin/venues');
  revalidatePath('/fields');
  return { ok: true, message: 'Venue added.' };
}

export async function closeVenueAction(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin('/admin/venues');

  const startsAt = text(form, 'startsAt');
  const endsAt = text(form, 'endsAt');

  try {
    await closeVenue(principal, {
      venueId: text(form, 'venueId'),
      startsAt: startsAt ? new Date(startsAt) : new Date(),
      endsAt: endsAt ? new Date(endsAt) : null,
      reason: text(form, 'reason'),
      source: optionalText(form, 'source') ?? null,
    });
  } catch (error) {
    return explain(error);
  }

  revalidatePath('/admin/venues');
  revalidatePath('/fields');
  revalidatePath('/schedule');
  return { ok: true, message: 'Closure recorded and published.' };
}

export async function reopenVenueAction(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin('/admin/venues');

  try {
    await reopenVenue(principal, text(form, 'closureId'));
  } catch (error) {
    return explain(error);
  }

  revalidatePath('/admin/venues');
  revalidatePath('/fields');
  return { ok: true, message: 'Reopened. The closure stays on the record.' };
}

// --- standings ---------------------------------------------------------------

export async function recomputeStandingsAction(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin('/admin');

  try {
    const outcome = await recomputeStandings(principal, text(form, 'stageGroupId'));
    revalidatePath('/standings');
    return {
      ok: true,
      message: `Recomputed: ${outcome.fixturesCounted} counted, ${outcome.fixturesDisputed} disputed, ${outcome.fixturesOutstanding} still to play.`,
    };
  } catch (error) {
    return explain(error);
  }
}

// --- historical import -------------------------------------------------------

export async function stageImportAction(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin('/admin/import');
  const file = form.get('export');

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an export file to stage.' };
  }

  try {
    const batch = await stageImport(principal, await file.text(), {
      source: file.name,
      dryRun: form.get('dryRun') === 'on',
    });
    const resolved = await resolveImport(principal, batch.batchId);

    revalidatePath('/admin/import');
    return {
      ok: true,
      message:
        `Staged ${batch.recordsTotal} records. ${resolved.matched} matched, ` +
        `${resolved.createdAsNew} new, ${resolved.needsReview} need a decision.`,
    };
  } catch (error) {
    return explain(error);
  }
}

export async function confirmMatchAction(form: FormData): Promise<ActionResult> {
  const batchId = text(form, 'batchId');
  const principal = await requireAdmin(`/admin/import/${batchId}`);

  try {
    await confirmMatch(principal, text(form, 'recordId'), text(form, 'canonicalId'));
  } catch (error) {
    return explain(error);
  }

  revalidatePath(`/admin/import/${batchId}`);
  return { ok: true, message: 'Matched. Every later season with this spelling now resolves on its own.' };
}

export async function rejectMatchAction(form: FormData): Promise<ActionResult> {
  const batchId = text(form, 'batchId');
  const principal = await requireAdmin(`/admin/import/${batchId}`);

  try {
    await rejectMatch(principal, text(form, 'recordId'));
  } catch (error) {
    return explain(error);
  }

  revalidatePath(`/admin/import/${batchId}`);
  return { ok: true, message: 'Recorded as new. It will be created on promotion.' };
}

export async function promoteImportAction(form: FormData): Promise<ActionResult> {
  const batchId = text(form, 'batchId');
  const principal = await requireAdmin(`/admin/import/${batchId}`);

  try {
    const outcome = await promoteImport(principal, batchId);
    revalidatePath(`/admin/import/${batchId}`);
    revalidatePath('/clubs');

    if (outcome.blockedByReview > 0) {
      return {
        ok: false,
        message: `${outcome.blockedByReview} rows still need a decision. Nothing was written.`,
      };
    }
    return {
      ok: true,
      message: `Created ${outcome.clubsCreated} clubs, ${outcome.teamsCreated} teams, ${outcome.venuesCreated} venues. ${outcome.skipped} already existed.`,
    };
  } catch (error) {
    return explain(error);
  }
}
