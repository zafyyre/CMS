import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { type OrgId, unsafeAsOrgId } from '../../src/db/org-id';
import * as schema from '../../src/db/schema';
import { assertTestDatabaseName, assertTestDatabaseUrl } from './test-database';

/**
 * Test fixtures are created through a SUPERUSER connection.
 *
 * This is deliberate, and it is what gives the isolation suite its force: setup
 * writes rows that RLS would never let the application create, and the
 * assertions then run as `app_user` through ordinary application code. So the
 * tests prove that app_user cannot reach another league's data *regardless of
 * what data exists* — rather than merely proving that data the app never
 * created cannot be read.
 */

const seedUrl = process.env.TEST_SEED_DATABASE_URL;
if (!seedUrl) throw new Error('TEST_SEED_DATABASE_URL is not set');
assertTestDatabaseUrl('TEST_SEED_DATABASE_URL', seedUrl);

const rootPool = new Pool({ connectionString: seedUrl, max: 2 });
export const rootDb = drizzle(rootPool, { schema });

export interface LeagueFixture {
  orgId: OrgId;
  slug: string;
  registrationYearId: string;
  seasonId: string;
  seriesId: string;
  editionId: string;
  stageId: string;
  stageGroupId: string;
  clubId: string;
  teamId: string;
  entryId: string;
  personId: string;
  honourId: string;
}

/** Builds a complete, self-consistent league. Used twice, to test isolation. */
export async function createLeagueFixture(slug: string): Promise<LeagueFixture> {
  const orgId = uuidv7();
  const registrationYearId = uuidv7();
  const seasonId = uuidv7();
  const seriesId = uuidv7();
  const editionId = uuidv7();
  const stageId = uuidv7();
  const stageGroupId = uuidv7();
  const clubId = uuidv7();
  const teamId = uuidv7();
  const entryId = uuidv7();
  const personId = uuidv7();
  const honourId = uuidv7();

  await rootDb.insert(schema.organizations).values({
    id: orgId,
    slug,
    name: `${slug} league`,
    timezone: 'America/Vancouver',
  });

  await rootDb
    .insert(schema.orgDomains)
    .values({ orgId, hostname: `${slug}.test.invalid`, isPrimary: true });

  await rootDb.insert(schema.registrationYears).values({
    id: registrationYearId,
    orgId,
    label: '2025-26',
    slug: '2025-26',
    startsOn: '2025-07-01',
    endsOn: '2026-06-30',
  });

  await rootDb.insert(schema.seasons).values({
    id: seasonId,
    orgId,
    registrationYearId,
    name: 'Autumn 2025-26',
    slug: 'autumn-2025-26',
    status: 'IN_PROGRESS',
  });

  await rootDb.insert(schema.competitionSeries).values({
    id: seriesId,
    orgId,
    name: 'Premier Division',
    slug: 'premier',
  });

  await rootDb.insert(schema.competitionEditions).values({
    id: editionId,
    orgId,
    seriesId,
    seasonId,
    slug: 'premier',
    tier: 1,
  });

  await rootDb.insert(schema.stages).values({
    id: stageId,
    orgId,
    editionId,
    ordinal: 1,
    name: 'Regular Season',
    slug: 'regular',
    format: 'ROUND_ROBIN',
  });

  await rootDb.insert(schema.stageGroups).values({
    id: stageGroupId,
    orgId,
    stageId,
    name: 'Table',
    slug: 'table',
  });

  await rootDb
    .insert(schema.clubs)
    .values({ id: clubId, orgId, name: `${slug} FC`, slug: `${slug}-fc` });

  await rootDb
    .insert(schema.teams)
    .values({ id: teamId, orgId, clubId, name: `${slug} FC`, slug: `${slug}-fc` });

  await rootDb
    .insert(schema.editionEntries)
    .values({ id: entryId, orgId, editionId, teamId, status: 'ACTIVE' });

  await rootDb.insert(schema.persons).values({
    id: personId,
    orgId,
    givenName: 'Test',
    familyName: slug,
    displayName: `Test ${slug}`,
    dateOfBirth: '1990-01-01',
  });

  await rootDb.insert(schema.honours).values({
    id: honourId,
    orgId,
    name: `${slug} Trophy`,
    slug: `${slug}-trophy`,
    recipientKind: 'TEAM',
  });

  return {
    orgId: unsafeAsOrgId(orgId, 'test fixture'),
    slug,
    registrationYearId,
    seasonId,
    seriesId,
    editionId,
    stageId,
    stageGroupId,
    clubId,
    teamId,
    entryId,
    personId,
    honourId,
  };
}

export interface MatchDayFixture {
  municipalityId: string;
  venueId: string;
  opponentClubId: string;
  opponentTeamId: string;
  opponentEntryId: string;
  fixtureId: string;
}

/**
 * A venue and a real fixture between two teams, layered onto a league.
 *
 * Kept separate from `createLeagueFixture` rather than folded into it: the
 * cross-tenant isolation suite asserts "exactly one row per table" as its
 * proof that the other league's identical row is invisible, and a second team
 * would quietly turn that into a weaker assertion.
 */
export async function createMatchDayFixture(league: LeagueFixture): Promise<MatchDayFixture> {
  const { orgId, slug } = league;
  const municipalityId = uuidv7();
  const venueId = uuidv7();
  const opponentClubId = uuidv7();
  const opponentTeamId = uuidv7();
  const opponentEntryId = uuidv7();
  const fixtureId = uuidv7();

  await rootDb.insert(schema.municipalities).values({
    id: municipalityId,
    orgId,
    code: slug.slice(0, 3).toUpperCase(),
    name: `${slug} City`,
  });

  await rootDb.insert(schema.venues).values({
    id: venueId,
    orgId,
    municipalityId,
    name: `${slug} Park`,
    slug: `${slug}-park`,
    surface: 'GRASS',
  });

  await rootDb
    .insert(schema.clubs)
    .values({ id: opponentClubId, orgId, name: `${slug} Athletic`, slug: `${slug}-athletic` });

  await rootDb.insert(schema.teams).values({
    id: opponentTeamId,
    orgId,
    clubId: opponentClubId,
    name: `${slug} Athletic`,
    slug: `${slug}-athletic`,
  });

  await rootDb.insert(schema.editionEntries).values({
    id: opponentEntryId,
    orgId,
    editionId: league.editionId,
    teamId: opponentTeamId,
    status: 'ACTIVE',
  });

  await rootDb.insert(schema.fixtures).values({
    id: fixtureId,
    orgId,
    stageGroupId: league.stageGroupId,
    homeEntryId: league.entryId,
    awayEntryId: opponentEntryId,
    venueId,
    // 14:00 in Vancouver on an ordinary October Saturday.
    kickoffAt: new Date('2025-10-04T21:00:00.000Z'),
    matchday: 1,
    status: 'SCHEDULED',
  });

  return {
    municipalityId,
    venueId,
    opponentClubId,
    opponentTeamId,
    opponentEntryId,
    fixtureId,
  };
}

export async function truncateAll(): Promise<void> {
  const target = await rootPool.query<{ database: string }>(
    'select current_database() as database',
  );
  assertTestDatabaseName(target.rows[0]?.database, 'TEST_SEED_DATABASE_URL');

  await rootPool.query(`
    TRUNCATE TABLE
      articles, documents,
      entity_aliases, import_records, import_batches,
      standings_rows, standings_snapshots,
      match_events, result_submissions, fixture_changes, fixtures,
      venue_closures, venues, municipalities,
      person_registrations, stage_group_entries, edition_entries,
      eligibility_rules, eligibility_profiles, teams, clubs,
      honour_awards, honours, progression_rules, stage_entry_sources,
      stage_groups, stages, competition_editions, competition_series,
      competition_rules,
      ladders, seasons, registration_years, governing_bodies,
      consents, guardianships, role_grants, persons,
      audit_log, org_domains, organizations,
      two_factors, sessions, accounts, verifications, users
    RESTART IDENTITY CASCADE;
  `);
}

export async function closeFixtures(): Promise<void> {
  await rootPool.end();
}
