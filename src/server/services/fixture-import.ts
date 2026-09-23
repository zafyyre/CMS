import { and, eq, isNull } from 'drizzle-orm';
import { type Tx, withOrg } from '@/db';
import {
  competitionEditions,
  competitionSeries,
  editionEntries,
  fixtures,
  stageGroups,
  stages,
  teams,
  venues,
} from '@/db/schema';
import { CsvFormatError, parseCsvTable } from '@/lib/csv';
import { NonExistentLocalTimeError, resolveZonedWallTime } from '@/lib/time';
import { assertCan } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import { getLeagueTimeZone, insertFixture, type ScheduleFixtureInput } from './fixtures';

/**
 * Bulk fixture import.
 *
 * The league is not going to hand-enter a hundred and ninety teams' schedules,
 * so this is not a convenience — without it the whole phase is unusable and
 * the schedule stays in the spreadsheet it is in today.
 *
 * Three properties make it safe to hand to a league administrator:
 *
 *   **Dry run first.** `dryRun` resolves and validates every row and writes
 *   nothing, so the operator sees all four hundred errors at once rather than
 *   discovering them one failed upload at a time.
 *
 *   **Idempotent.** A fixture already present for the same teams, group and leg
 *   is reported as a skip rather than duplicated. Re-uploading a corrected file
 *   is the normal workflow, and a schedule silently doubled is much worse than
 *   an import that refuses.
 *
 *   **All or nothing.** A live run is one transaction. A file that fails on
 *   row 300 leaves nothing behind, so there is no half-imported season to
 *   reconcile by hand.
 */

const REQUIRED_COLUMNS = ['competition', 'group', 'home', 'away'] as const;

export interface FixtureImportOptions {
  /** Resolve and validate every row, write nothing. Always run this first. */
  dryRun?: boolean;
  /**
   * Restrict competition lookup to one season.
   *
   * Worth setting whenever it is known: "Division 2" names an edition in every
   * season the league has ever run, and without a season the import matches
   * whichever one it happens to see first.
   */
  seasonId?: string;
}

export type RowOutcome = 'CREATED' | 'SKIPPED' | 'ERROR';

export interface FixtureImportRow {
  line: number;
  outcome: RowOutcome;
  message: string;
  fixtureId?: string;
}

export interface FixtureImportReport {
  dryRun: boolean;
  created: number;
  skipped: number;
  errors: number;
  rows: FixtureImportRow[];
}

/**
 * The columns, and what they accept:
 *
 *   competition  edition slug, or the series name        (required)
 *   group        stage group slug, or its name           (required)
 *   home, away   team name or slug                       (required)
 *   date         YYYY-MM-DD, league-local                 (optional)
 *   time         HH:MM, league-local, 24-hour             (optional)
 *   venue        venue name or slug                       (optional)
 *   round        knockout round number                    (optional)
 *   matchday     league matchday number                   (optional)
 *   leg          1 or 2                                   (optional, default 1)
 *   note         shown on the public schedule             (optional)
 */
export async function importFixturesFromCsv(
  principal: Principal,
  csv: string,
  options: FixtureImportOptions = {},
): Promise<FixtureImportReport> {
  // Before parsing anything. An unauthorized caller should not be able to
  // learn which competitions and teams exist from the error messages.
  assertCan(principal, 'create', { type: 'fixture' });

  const table = parseCsvTable(csv, REQUIRED_COLUMNS);
  const dryRun = options.dryRun ?? false;

  return withOrg(principal.orgId, async (tx) => {
    const timeZone = await getLeagueTimeZone(tx, principal.orgId);
    const index = await buildIndex(tx, options.seasonId);
    const plans = table.rows.map((row) => planRow(row, index, timeZone));

    const failed = plans.filter((p) => p.outcome === 'ERROR');
    const skipped = plans.filter((p) => p.outcome === 'SKIPPED');
    const creatable = plans.filter((p) => p.outcome === 'CREATED');

    /**
     * A file with any bad row imports nothing.
     *
     * Partially importing a schedule is the worst outcome available: the
     * operator now has to work out which of four hundred fixtures landed
     * before they can safely re-upload, and re-uploading is the obvious thing
     * to try. Refusing wholesale keeps the fix trivial — correct the file,
     * upload it again.
     */
    if (dryRun || failed.length > 0) {
      return report(dryRun, [
        ...failed,
        ...skipped,
        ...creatable.map((plan) => ({
          line: plan.line,
          outcome: (failed.length > 0 ? 'ERROR' : 'CREATED') as RowOutcome,
          message:
            failed.length > 0
              ? 'Not imported — the file has errors elsewhere, so nothing was written.'
              : `Would create: ${plan.message}`,
        })),
      ]);
    }

    // One transaction for the whole file, so a constraint violation on row 300
    // rolls back the first 299 rather than leaving half a season behind.
    const written: FixtureImportRow[] = [];
    for (const plan of creatable) {
      const created = await insertFixture(tx, principal, {
        ...plan.input,
        reason: `Imported from CSV (line ${plan.line}).`,
      });
      written.push({
        line: plan.line,
        outcome: 'CREATED',
        message: plan.message,
        fixtureId: created.id,
      });
    }

    return report(dryRun, [...skipped, ...written]);
  });
}

function report(dryRun: boolean, rows: FixtureImportRow[]): FixtureImportReport {
  const ordered = [...rows].sort((a, b) => a.line - b.line);
  return {
    dryRun,
    created: ordered.filter((r) => r.outcome === 'CREATED').length,
    skipped: ordered.filter((r) => r.outcome === 'SKIPPED').length,
    errors: ordered.filter((r) => r.outcome === 'ERROR').length,
    rows: ordered,
  };
}

// --- planning ----------------------------------------------------------------

interface PlannedRow extends FixtureImportRow {
  input: ScheduleFixtureInput;
}

interface ImportIndex {
  /** Both the edition slug and the lower-cased series name point at the edition. */
  editions: Map<string, { id: string; label: string }>;
  /** Keyed `${editionId}::${slug-or-name}`. */
  groups: Map<string, { id: string; label: string }>;
  /** Keyed `${editionId}::${team slug-or-name}` → the team's entry in it. */
  entries: Map<string, { entryId: string; label: string }>;
  venues: Map<string, { id: string; label: string }>;
  /** Existing fixtures, so a re-upload skips rather than duplicates. */
  existing: Set<string>;
}

async function buildIndex(tx: Tx, seasonId?: string): Promise<ImportIndex> {
  const index: ImportIndex = {
    editions: new Map(),
    groups: new Map(),
    entries: new Map(),
    venues: new Map(),
    existing: new Set(),
  };

  const editionRows = await tx
    .select({
      id: competitionEditions.id,
      slug: competitionEditions.slug,
      seasonId: competitionEditions.seasonId,
      seriesName: competitionSeries.name,
      seriesSlug: competitionSeries.slug,
      nameOverride: competitionEditions.nameOverride,
    })
    .from(competitionEditions)
    .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
    .where(isNull(competitionEditions.deletedAt));

  for (const row of editionRows) {
    if (seasonId && row.seasonId !== seasonId) continue;
    const label = row.nameOverride ?? row.seriesName;
    for (const key of [row.slug, row.seriesSlug, row.seriesName, row.nameOverride]) {
      if (key) index.editions.set(normalize(key), { id: row.id, label });
    }
  }

  const groupRows = await tx
    .select({
      id: stageGroups.id,
      name: stageGroups.name,
      slug: stageGroups.slug,
      editionId: stages.editionId,
    })
    .from(stageGroups)
    .innerJoin(stages, eq(stageGroups.stageId, stages.id))
    .where(and(isNull(stageGroups.deletedAt), isNull(stages.deletedAt)));

  for (const row of groupRows) {
    for (const key of [row.slug, row.name]) {
      index.groups.set(`${row.editionId}::${normalize(key)}`, { id: row.id, label: row.name });
    }
  }

  const entryRows = await tx
    .select({
      entryId: editionEntries.id,
      editionId: editionEntries.editionId,
      teamName: teams.name,
      teamSlug: teams.slug,
    })
    .from(editionEntries)
    .innerJoin(teams, eq(editionEntries.teamId, teams.id))
    .where(and(isNull(editionEntries.deletedAt), isNull(teams.deletedAt)));

  for (const row of entryRows) {
    for (const key of [row.teamSlug, row.teamName]) {
      index.entries.set(`${row.editionId}::${normalize(key)}`, {
        entryId: row.entryId,
        label: row.teamName,
      });
    }
  }

  const venueRows = await tx
    .select({ id: venues.id, name: venues.name, slug: venues.slug })
    .from(venues)
    .where(isNull(venues.deletedAt));

  for (const row of venueRows) {
    for (const key of [row.slug, row.name]) {
      index.venues.set(normalize(key), { id: row.id, label: row.name });
    }
  }

  const existingRows = await tx
    .select({
      stageGroupId: fixtures.stageGroupId,
      homeEntryId: fixtures.homeEntryId,
      awayEntryId: fixtures.awayEntryId,
      leg: fixtures.leg,
    })
    .from(fixtures)
    .where(isNull(fixtures.deletedAt));

  for (const row of existingRows) {
    index.existing.add(pairingKey(row.stageGroupId, row.homeEntryId, row.awayEntryId, row.leg));
  }

  return index;
}

function planRow(
  row: { line: number; get: (column: string) => string },
  index: ImportIndex,
  timeZone: string,
): PlannedRow {
  const fail = (message: string): PlannedRow => ({
    line: row.line,
    outcome: 'ERROR',
    message,
    input: { stageGroupId: '' },
  });

  const competition = index.editions.get(normalize(row.get('competition')));
  if (!competition) {
    return fail(`Unknown competition "${row.get('competition')}".`);
  }

  const group = index.groups.get(`${competition.id}::${normalize(row.get('group'))}`);
  if (!group) {
    return fail(`"${row.get('group')}" is not a group in ${competition.label}.`);
  }

  const home = index.entries.get(`${competition.id}::${normalize(row.get('home'))}`);
  if (!home) {
    return fail(`"${row.get('home')}" is not entered in ${competition.label}.`);
  }
  const away = index.entries.get(`${competition.id}::${normalize(row.get('away'))}`);
  if (!away) {
    return fail(`"${row.get('away')}" is not entered in ${competition.label}.`);
  }
  if (home.entryId === away.entryId) {
    return fail(`"${home.label}" cannot play itself.`);
  }

  const venueName = row.get('venue');
  let venueId: string | null = null;
  if (venueName) {
    const venue = index.venues.get(normalize(venueName));
    if (!venue) return fail(`Unknown venue "${venueName}".`);
    venueId = venue.id;
  }

  const leg = parseOptionalInt(row.get('leg'), 1);
  if (leg === undefined || leg === null || leg < 1) {
    return fail(`"${row.get('leg')}" is not a valid leg number.`);
  }

  const round = parseOptionalInt(row.get('round'), null);
  if (round === undefined) return fail(`"${row.get('round')}" is not a valid round number.`);
  const matchday = parseOptionalInt(row.get('matchday'), null);
  if (matchday === undefined) {
    return fail(`"${row.get('matchday')}" is not a valid matchday number.`);
  }

  let kickoffLocal: string | null = null;
  const date = row.get('date');
  const time = row.get('time');
  if (date && time) {
    kickoffLocal = `${date}T${normalizeTime(time)}`;
    try {
      resolveZonedWallTime(kickoffLocal, timeZone);
    } catch (error) {
      if (error instanceof NonExistentLocalTimeError) {
        return fail(
          `${date} ${time} does not exist in ${timeZone} — the clocks change that night.`,
        );
      }
      return fail(`"${date} ${time}" is not a valid date and time.`);
    }
  } else if (date || time) {
    return fail('Give both a date and a time, or neither.');
  }

  if (index.existing.has(pairingKey(group.id, home.entryId, away.entryId, leg))) {
    return {
      line: row.line,
      outcome: 'SKIPPED',
      message: `${home.label} v ${away.label} is already scheduled in ${group.label}.`,
      input: { stageGroupId: group.id },
    };
  }

  // Guards against the same pairing appearing twice within one file, which the
  // database would happily accept.
  index.existing.add(pairingKey(group.id, home.entryId, away.entryId, leg));

  return {
    line: row.line,
    outcome: 'CREATED',
    message: `${home.label} v ${away.label}`,
    input: {
      stageGroupId: group.id,
      homeEntryId: home.entryId,
      awayEntryId: away.entryId,
      venueId,
      kickoffLocal,
      round: round ?? null,
      matchday: matchday ?? null,
      leg,
      publicNote: row.get('note') || null,
    },
  };
}

// --- helpers -----------------------------------------------------------------

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const pairingKey = (
  stageGroupId: string,
  homeEntryId: string | null,
  awayEntryId: string | null,
  leg: number,
): string => `${stageGroupId}|${homeEntryId ?? '?'}|${awayEntryId ?? '?'}|${leg}`;

/** `undefined` means "present but not a number", which is an error, not a default. */
function parseOptionalInt<T extends number | null>(
  raw: string,
  fallback: T,
): number | T | undefined {
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/** Accepts "14:00", "14:00:00" and "2:05". */
function normalizeTime(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!match) return raw;
  const [, h, m, s] = match;
  return `${String(h).padStart(2, '0')}:${m}${s ? `:${s}` : ''}`;
}

export { CsvFormatError };
