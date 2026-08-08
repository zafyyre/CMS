import { z } from 'zod';

/**
 * The shape a historical export has to arrive in.
 *
 * Deliberately close to what a legacy system actually emits rather than to our
 * own schema: every source key is the SOURCE's identifier, and nothing here
 * mentions org ids, UUIDs or our table names. Transforming on the way in would
 * mean a mapping bug is only findable by re-fetching the original file — which,
 * for a scrape of a site that has since changed, may no longer exist.
 *
 * `key` fields are natural keys in the source system. They are what makes the
 * import idempotent: the same key in the same batch is the same row, however
 * many times the file is loaded.
 *
 * Validated with zod at the boundary, because the one guarantee a
 * twelve-year-old export does not offer is that it is well-formed.
 */

const key = z.string().min(1).max(200);
const name = z.string().min(1).max(300);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const localTime = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'expected HH:MM');

export const legacyClubSchema = z.object({
  key,
  name,
  shortName: z.string().max(100).optional(),
  foundedYear: z.number().int().min(1800).max(2200).optional(),
});

export const legacyTeamSchema = z.object({
  key,
  name,
  clubKey: key.optional(),
  designation: z.string().max(100).optional(),
});

export const legacyVenueSchema = z.object({
  key,
  name,
  municipality: z.string().max(100).optional(),
  surface: z.enum(['GRASS', 'ARTIFICIAL_TURF', 'INDOOR', 'UNKNOWN']).optional(),
  address: z.string().max(500).optional(),
});

export const legacyFixtureSchema = z.object({
  key,
  competitionKey: key,
  groupKey: key.optional(),
  homeTeamKey: key,
  awayTeamKey: key,
  /** League-local. Converted through the league's timezone, never assumed UTC. */
  date: isoDate.optional(),
  time: localTime.optional(),
  venueKey: key.optional(),
  round: z.number().int().min(0).optional(),
  matchday: z.number().int().min(0).optional(),
  homeScore: z.number().int().min(0).nullable().optional(),
  awayScore: z.number().int().min(0).nullable().optional(),
  homeForfeit: z.boolean().optional(),
  awayForfeit: z.boolean().optional(),
  status: z
    .enum(['SCHEDULED', 'PLAYED', 'POSTPONED', 'CANCELLED', 'FORFEITED', 'ABANDONED', 'AWARDED'])
    .optional(),
});

/**
 * The source's OWN final table.
 *
 * Imported not to be displayed but to be argued with: recompute the table from
 * the imported results and diff it against this. That one comparison validates
 * the importer, the schema and the standings engine at once.
 */
export const legacyStandingRowSchema = z.object({
  teamKey: key.optional(),
  teamName: name,
  position: z.number().int().min(1).optional(),
  played: z.number().int().min(0).optional(),
  won: z.number().int().min(0).optional(),
  drawn: z.number().int().min(0).optional(),
  lost: z.number().int().min(0).optional(),
  goalsFor: z.number().int().min(0).optional(),
  goalsAgainst: z.number().int().min(0).optional(),
  points: z.number().int().optional(),
});

export const legacyStandingSchema = z.object({
  key,
  competitionKey: key,
  groupKey: key.optional(),
  rows: z.array(legacyStandingRowSchema),
});

export const legacyHonourSchema = z.object({
  key,
  honourName: name,
  seasonKey: key.optional(),
  recipientName: name,
  value: z.number().int().optional(),
  awardedOn: isoDate.optional(),
});

export const legacyExportSchema = z.object({
  version: z.literal(1),
  /** Free text: which system, which export, when. Recorded on the batch. */
  source: z.string().min(1).max(300),
  clubs: z.array(legacyClubSchema).default([]),
  teams: z.array(legacyTeamSchema).default([]),
  venues: z.array(legacyVenueSchema).default([]),
  fixtures: z.array(legacyFixtureSchema).default([]),
  standings: z.array(legacyStandingSchema).default([]),
  honours: z.array(legacyHonourSchema).default([]),
});

export type LegacyExport = z.infer<typeof legacyExportSchema>;
export type LegacyClub = z.infer<typeof legacyClubSchema>;
export type LegacyTeam = z.infer<typeof legacyTeamSchema>;
export type LegacyVenue = z.infer<typeof legacyVenueSchema>;
export type LegacyFixture = z.infer<typeof legacyFixtureSchema>;
export type LegacyStanding = z.infer<typeof legacyStandingSchema>;
export type LegacyHonour = z.infer<typeof legacyHonourSchema>;

export class ImportFormatError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

/**
 * Parse and validate, reporting EVERY problem rather than the first.
 *
 * An operator fixing a twelve-season export one error per upload is an
 * operator who gives up and edits the database by hand.
 */
export function parseLegacyExport(raw: string): LegacyExport {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ImportFormatError(
      `The file is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const parsed = legacyExportSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ImportFormatError(
      `The export does not match the expected format (${issues.length} problem${issues.length === 1 ? '' : 's'}).`,
      issues,
    );
  }

  return parsed.data;
}
