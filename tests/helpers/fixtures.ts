import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { type OrgId, unsafeAsOrgId } from '../../src/db/org-id';
import * as schema from '../../src/db/schema';

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

export async function truncateAll(): Promise<void> {
  await rootPool.query(`
    TRUNCATE TABLE
      person_registrations, stage_group_entries, edition_entries,
      eligibility_rules, eligibility_profiles, teams, clubs,
      honour_awards, honours, progression_rules, stage_entry_sources,
      stage_groups, stages, competition_editions, competition_series,
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
