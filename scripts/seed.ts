import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/db/schema';

config({ path: '.env' });

/**
 * Development seed.
 *
 * Runs as the superuser, because creating a league is deliberately impossible
 * for `app_user`: there is no INSERT policy on `organizations`, so provisioning
 * is an operational act rather than something a web request can perform.
 *
 * The data is a FICTIONAL league. That is intentional — seeding with a real
 * league's clubs and trophies is how a schema quietly acquires one league's
 * specifics, and this is a multi-tenant product. It is shaped to exercise the
 * parts of the model that matter: a division running as parallel sections that
 * must resolve one champion, a knockout cup, promotion and relegation as data,
 * and a perpetual trophy with a lineage of past winners.
 */

const useTestDb = process.argv.includes('--test');
const reset = process.argv.includes('--reset');

const url = useTestDb ? process.env.TEST_SEED_DATABASE_URL : process.env.SEED_DATABASE_URL;
if (!url) throw new Error('SEED_DATABASE_URL (or TEST_SEED_DATABASE_URL) is not set');

const client = new Client({ connectionString: url });
const db = drizzle(client, { schema });

const ORG_SLUG = process.env.DEFAULT_ORG_SLUG ?? 'demo';

/**
 * Invented clubs, named after Kelowna neighbourhoods and nearby Okanagan
 * communities so the demo reads plausibly for its setting. None of these are
 * real clubs — the seed is deliberately fictional, because populating the
 * schema with an actual league's clubs and trophies is how a multi-tenant
 * product quietly acquires one tenant's specifics.
 */
const CLUB_NAMES = [
  'Rutland Rovers',
  'Glenmore Athletic',
  'Mission Creek FC',
  'Black Mountain United',
  'Okanagan Lake City',
  'Westbank Wanderers',
  'Lake Country Celtic',
  'Peachland Albion',
  'Ellison Dynamo',
  'Kettle Valley FC',
  'Pandosy Rangers',
  'Knox Mountain Victoria',
];

const GIVEN = ['Aiden','Mateo','Harpreet','Luca','Daniel','Marco','Jaskaran','Owen','Nikola','Tomas','Samuel','Arjun','Liam','Diego','Ravi','Ethan'];
const FAMILY = ['Silva','Grewal','Rossi','Novak','Fernandes','Sandhu','Kovac','Martins','Nguyen','Antonelli','Dhaliwal','Petrovic','Costa','Bains','Moreno','Clarke'];

/** Deterministic pseudo-random, so reseeding produces identical fixtures. */
function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function main() {
  await client.connect();
  console.log(`\n▸ seeding ${useTestDb ? 'test' : 'development'} database`);

  if (reset) {
    await client.query(`
      TRUNCATE TABLE
        person_registrations, stage_group_entries, edition_entries,
        eligibility_rules, eligibility_profiles, teams, clubs,
        honour_awards, honours, progression_rules, stage_entry_sources,
        stage_groups, stages, competition_editions, competition_series,
        ladders, seasons, registration_years, governing_bodies,
        consents, guardianships, role_grants, persons,
        audit_log, org_domains, organizations
      RESTART IDENTITY CASCADE;
    `);
    console.log('  existing data truncated');
  }

  const existing = await client.query('select 1 from organizations where slug = $1', [ORG_SLUG]);
  if ((existing.rowCount ?? 0) > 0 && !reset) {
    console.log(`  league "${ORG_SLUG}" already exists — nothing to do`);
    console.log('  re-run with --reset to rebuild from scratch\n');
    return;
  }

  const rng = makeRng(20252026);

  // --- the league -----------------------------------------------------------
  const orgId = uuidv7();
  await db.insert(schema.organizations).values({
    id: orgId,
    slug: ORG_SLUG,
    name: 'Kelowna Metro League',
    shortName: 'KML',
    timezone: 'America/Vancouver',
    theme: { accentHue: 155 },
  });

  await db.insert(schema.orgDomains).values([
    { orgId, hostname: 'kelowna.localhost', isPrimary: true },
    { orgId, hostname: 'www.kelowna.localhost', isPrimary: false },
  ]);

  // --- time -----------------------------------------------------------------
  const regYearId = uuidv7();
  await db.insert(schema.registrationYears).values({
    id: regYearId,
    orgId,
    label: '2025-26',
    slug: '2025-26',
    startsOn: '2025-07-01',
    endsOn: '2026-06-30',
    registrationOpensOn: '2025-07-01',
    registrationClosesOn: '2025-09-30',
  });

  // Two campaigns inside ONE registration year — which is the point: a player
  // registers once and is eligible in both.
  const autumnId = uuidv7();
  const springId = uuidv7();
  await db.insert(schema.seasons).values([
    {
      id: autumnId,
      orgId,
      registrationYearId: regYearId,
      name: 'Autumn/Winter 2025-26',
      slug: 'autumn-winter-2025-26',
      ordinalInYear: 1,
      startsOn: '2025-09-06',
      endsOn: '2026-04-26',
      rosterLockOn: '2026-02-28',
      status: 'IN_PROGRESS',
    },
    {
      id: springId,
      orgId,
      registrationYearId: regYearId,
      name: 'Spring 2026',
      slug: 'spring-2026',
      ordinalInYear: 2,
      startsOn: '2026-05-02',
      endsOn: '2026-06-27',
      status: 'PLANNED',
    },
  ]);

  // --- eligibility, as data -------------------------------------------------
  const openProfileId = uuidv7();
  const mastersProfileId = uuidv7();
  await db.insert(schema.eligibilityProfiles).values([
    { id: openProfileId, orgId, name: 'Open age', slug: 'open', description: 'Any registered player aged 16 or over.' },
    { id: mastersProfileId, orgId, name: 'Over-35', slug: 'over-35', description: 'Aged 35 or over as at the season start.' },
  ]);
  await db.insert(schema.eligibilityRules).values([
    { orgId, profileId: openProfileId, minAge: 16, ageReferenceMode: 'SEASON_START', screeningRequired: 'NOT_REQUIRED' },
    { orgId, profileId: mastersProfileId, minAge: 35, ageReferenceMode: 'SEASON_START', screeningRequired: 'NOT_REQUIRED' },
  ]);

  // --- ladders (pyramids) ---------------------------------------------------
  const openLadderId = uuidv7();
  const mastersLadderId = uuidv7();
  await db.insert(schema.ladders).values([
    { id: openLadderId, orgId, name: 'Open', slug: 'open', sortOrder: 1, defaultEligibilityProfileId: openProfileId },
    { id: mastersLadderId, orgId, name: 'Over-35', slug: 'over-35', sortOrder: 2, ageBandLabel: 'O35', defaultEligibilityProfileId: mastersProfileId },
  ]);

  // --- series: perpetual lines ---------------------------------------------
  const premierSeriesId = uuidv7();
  const div1SeriesId = uuidv7();
  const div2SeriesId = uuidv7();
  const cupSeriesId = uuidv7();

  await db.insert(schema.competitionSeries).values([
    { id: premierSeriesId, orgId, name: 'Premier Division', slug: 'premier', ladderId: openLadderId, sortOrder: 1, foundedYear: 1974 },
    { id: div1SeriesId, orgId, name: 'Division 1', slug: 'division-1', ladderId: openLadderId, sortOrder: 2, foundedYear: 1974 },
    { id: div2SeriesId, orgId, name: 'Division 2', slug: 'division-2', ladderId: openLadderId, sortOrder: 3, foundedYear: 1981 },
    { id: cupSeriesId, orgId, name: 'Okanagan Cup', slug: 'okanagan-cup', sortOrder: 10, foundedYear: 1978 },
  ]);

  // --- editions: this season's running of each -----------------------------
  const premierEdId = uuidv7();
  const div1EdId = uuidv7();
  const div2EdId = uuidv7();
  const cupEdId = uuidv7();

  await db.insert(schema.competitionEditions).values([
    { id: premierEdId, orgId, seriesId: premierSeriesId, seasonId: autumnId, slug: 'premier', tier: 1, eligibilityProfileId: openProfileId, status: 'IN_PROGRESS' },
    { id: div1EdId, orgId, seriesId: div1SeriesId, seasonId: autumnId, slug: 'division-1', tier: 2, eligibilityProfileId: openProfileId, status: 'IN_PROGRESS' },
    { id: div2EdId, orgId, seriesId: div2SeriesId, seasonId: autumnId, slug: 'division-2', tier: 3, eligibilityProfileId: openProfileId, status: 'IN_PROGRESS' },
    { id: cupEdId, orgId, seriesId: cupSeriesId, seasonId: autumnId, slug: 'okanagan-cup', eligibilityProfileId: openProfileId, status: 'IN_PROGRESS' },
  ]);

  // --- stages ---------------------------------------------------------------
  // Premier and Division 1: a single double round-robin.
  const premierStageId = uuidv7();
  const div1StageId = uuidv7();
  // Division 2 runs as TWO parallel sections, then a ranking stage consolidates
  // them into one champion. This is the case the old site could not express
  // except by inventing two separate "divisions" named 2A and 2B.
  const div2GroupStageId = uuidv7();
  const div2FinalStageId = uuidv7();
  // The cup is a knockout with two-legged semi-finals.
  const cupStageId = uuidv7();

  await db.insert(schema.stages).values([
    { id: premierStageId, orgId, editionId: premierEdId, ordinal: 1, name: 'Regular Season', slug: 'regular', format: 'ROUND_ROBIN', legsPerPairing: 2 },
    { id: div1StageId, orgId, editionId: div1EdId, ordinal: 1, name: 'Regular Season', slug: 'regular', format: 'ROUND_ROBIN', legsPerPairing: 2 },
    { id: div2GroupStageId, orgId, editionId: div2EdId, ordinal: 1, name: 'Sections', slug: 'sections', format: 'ROUND_ROBIN', legsPerPairing: 2 },
    { id: div2FinalStageId, orgId, editionId: div2EdId, ordinal: 2, name: 'Championship Play-off', slug: 'championship', format: 'KNOCKOUT', legsPerTie: 1, tieBreakMethod: 'EXTRA_TIME_THEN_PENALTIES' },
    { id: cupStageId, orgId, editionId: cupEdId, ordinal: 1, name: 'Knockout', slug: 'knockout', format: 'KNOCKOUT', legsPerTie: 1, tieBreakMethod: 'PENALTIES' },
  ]);

  // --- groups ---------------------------------------------------------------
  const premierGroupId = uuidv7();
  const div1GroupId = uuidv7();
  const div2SectionAId = uuidv7();
  const div2SectionBId = uuidv7();
  const div2FinalGroupId = uuidv7();
  const cupR1Id = uuidv7();

  await db.insert(schema.stageGroups).values([
    { id: premierGroupId, orgId, stageId: premierStageId, name: 'Premier Division', slug: 'table', ordinal: 1 },
    { id: div1GroupId, orgId, stageId: div1StageId, name: 'Division 1', slug: 'table', ordinal: 1 },
    { id: div2SectionAId, orgId, stageId: div2GroupStageId, name: 'Section A', slug: 'section-a', ordinal: 1 },
    { id: div2SectionBId, orgId, stageId: div2GroupStageId, name: 'Section B', slug: 'section-b', ordinal: 2 },
    { id: div2FinalGroupId, orgId, stageId: div2FinalStageId, name: 'Final', slug: 'final', ordinal: 1, roundNumber: 1 },
    { id: cupR1Id, orgId, stageId: cupStageId, name: 'First Round', slug: 'round-1', ordinal: 1, roundNumber: 1 },
  ]);

  // The Division 2 final is contested by the winners of each section — as DATA,
  // not as a rule buried in a query.
  await db.insert(schema.stageEntrySources).values([
    { orgId, stageGroupId: div2FinalGroupId, slotNumber: 1, kind: 'STAGE_POSITION', sourceStageGroupId: div2SectionAId, sourcePosition: 1 },
    { orgId, stageGroupId: div2FinalGroupId, slotNumber: 2, kind: 'STAGE_POSITION', sourceStageGroupId: div2SectionBId, sourcePosition: 1 },
  ]);

  // Promotion and relegation as rows — which is what they always were.
  await db.insert(schema.progressionRules).values([
    { orgId, stageGroupId: premierGroupId, kind: 'RELEGATION', fromPosition: 9, toPosition: 10, targetSeriesId: div1SeriesId, note: 'Bottom two relegated to Division 1.' },
    { orgId, stageGroupId: div1GroupId, kind: 'PROMOTION', fromPosition: 1, toPosition: 2, targetSeriesId: premierSeriesId, note: 'Top two promoted to the Premier Division.' },
    { orgId, stageGroupId: div1GroupId, kind: 'RELEGATION', fromPosition: 9, toPosition: 10, targetSeriesId: div2SeriesId },
  ]);

  // --- honours: a trophy with a lineage ------------------------------------
  const founderTrophyId = uuidv7();
  const goldenBootId = uuidv7();
  await db.insert(schema.honours).values([
    { id: founderTrophyId, orgId, name: "The Founders' Trophy", slug: 'founders-trophy', recipientKind: 'TEAM', seriesId: premierSeriesId, establishedYear: 1974, description: 'Awarded to the Premier Division champions.' },
    { id: goldenBootId, orgId, name: 'Golden Boot', slug: 'golden-boot', recipientKind: 'PERSON', establishedYear: 1974, description: 'Leading goalscorer across all divisions.' },
  ]);

  // Historical winners, which the previous schema could not represent at all —
  // it stored a trophy as a text label on a division.
  await db.insert(schema.honourAwards).values([
    { orgId, honourId: founderTrophyId, recipientNameSnapshot: 'Glenmore Athletic', awardedOn: '2023-05-14' },
    { orgId, honourId: founderTrophyId, recipientNameSnapshot: 'Mission Creek FC', awardedOn: '2024-05-12' },
    { orgId, honourId: founderTrophyId, recipientNameSnapshot: 'Glenmore Athletic', awardedOn: '2025-05-11' },
    { orgId, honourId: goldenBootId, recipientNameSnapshot: 'Diego Moreno', value: 24, awardedOn: '2025-05-11' },
  ]);

  // --- clubs, teams, entries ------------------------------------------------
  const teamIds: string[] = [];
  for (const clubName of CLUB_NAMES) {
    const clubId = uuidv7();
    await db.insert(schema.clubs).values({
      id: clubId,
      orgId,
      name: clubName,
      slug: slugify(clubName),
      contactEmail: `${slugify(clubName)}@example.invalid`,
      foundedYear: 1950 + Math.floor(rng() * 60),
    });

    const sideCount = 1 + (rng() > 0.5 ? 1 : 0);
    for (let i = 0; i < sideCount; i++) {
      const designation = i === 0 ? 'First XI' : 'Reserves';
      const teamId = uuidv7();
      teamIds.push(teamId);
      await db.insert(schema.teams).values({
        id: teamId,
        orgId,
        clubId,
        name: i === 0 ? clubName : `${clubName} Reserves`,
        slug: slugify(i === 0 ? clubName : `${clubName} Reserves`),
        designation,
      });
    }
  }

  // Distribute teams across the four editions.
  const editionTargets = [
    { editionId: premierEdId, groupId: premierGroupId },
    { editionId: div1EdId, groupId: div1GroupId },
    { editionId: div2EdId, groupId: div2SectionAId },
    { editionId: div2EdId, groupId: div2SectionBId },
  ];

  const entryIds: string[] = [];
  teamIds.forEach((teamId, i) => {
    const target = editionTargets[i % editionTargets.length];
    if (!target) return;
    entryIds.push(uuidv7());
  });

  for (const [i, teamId] of teamIds.entries()) {
    const target = editionTargets[i % editionTargets.length];
    const entryId = entryIds[i];
    if (!target || !entryId) continue;

    await db.insert(schema.editionEntries).values({
      id: entryId,
      orgId,
      editionId: target.editionId,
      teamId,
      status: 'ACTIVE',
    });
    await db.insert(schema.stageGroupEntries).values({
      orgId,
      stageGroupId: target.groupId,
      editionEntryId: entryId,
      slotNumber: Math.floor(i / editionTargets.length) + 1,
    });
  }

  // --- people ---------------------------------------------------------------
  let playerCount = 0;
  for (const entryId of entryIds) {
    const squadSize = 14 + Math.floor(rng() * 4);
    for (let i = 0; i < squadSize; i++) {
      const given = GIVEN[Math.floor(rng() * GIVEN.length)] ?? 'Alex';
      const family = FAMILY[Math.floor(rng() * FAMILY.length)] ?? 'Smith';
      const personId = uuidv7();
      const birthYear = 1978 + Math.floor(rng() * 28);
      const month = String(1 + Math.floor(rng() * 12)).padStart(2, '0');
      const day = String(1 + Math.floor(rng() * 27)).padStart(2, '0');

      await db.insert(schema.persons).values({
        id: personId,
        orgId,
        givenName: given,
        familyName: family,
        displayName: `${given} ${family}`,
        dateOfBirth: `${birthYear}-${month}-${day}`,
      });

      await db.insert(schema.personRegistrations).values({
        orgId,
        personId,
        editionEntryId: entryId,
        seasonId: autumnId,
        status: 'ACTIVE',
        squadNumber: i + 1,
        validFrom: '2025-09-01',
        screeningStatus: 'NOT_REQUIRED',
      });
      playerCount++;
    }
  }

  console.log(`  league          1  (${ORG_SLUG})`);
  console.log('  registration yr 1  (2025-26, two campaigns)');
  console.log(`  series          4  (3 league + 1 cup)`);
  console.log(`  editions        4`);
  console.log(`  stages          5  (incl. a sectioned division + play-off)`);
  console.log(`  honours         2  with 4 historical awards`);
  console.log(`  clubs           ${CLUB_NAMES.length}`);
  console.log(`  teams           ${teamIds.length}`);
  console.log(`  entries         ${entryIds.length}`);
  console.log(`  players         ${playerCount}`);
  console.log('✓ seed complete\n');
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error('\n✗ seed failed\n');
    let current: unknown = err;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      console.error(`[${depth}] ${current.name}: ${current.message}`);
      const pg = current as Error & { detail?: string };
      if (pg.detail) console.error(`     detail=${pg.detail}`);
      current = current.cause;
    }
    await client.end().catch(() => {});
    process.exit(1);
  });
