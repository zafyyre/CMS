import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/db/schema';
import { unsafeAsOrgId } from '../src/db/org-id';
import { zonedWallTimeToInstant } from '../src/lib/time';
import { recomputeStandingsWithin } from '../src/server/standings/recompute';

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

/**
 * A single round-robin draw: every team plays every other team once.
 *
 * The circle method — fix one team, rotate the rest — which produces a
 * schedule where nobody plays twice on the same matchday. Generating pairs
 * naively and dealing them out sequentially would put a team on the pitch
 * twice in an afternoon, and the demo would look wrong to anyone who runs a
 * league for a living.
 *
 * An odd number of teams gets a bye, represented by the placeholder being
 * dropped from that round.
 */
function roundRobin(entryIds: readonly string[]): [string, string][][] {
  const teams = [...entryIds];
  if (teams.length % 2 === 1) teams.push('__bye__');

  const rounds: [string, string][][] = [];
  const half = teams.length / 2;
  const rotating = teams.slice(1);

  for (let round = 0; round < teams.length - 1; round++) {
    const order = [teams[0] as string, ...rotating];
    const pairings: [string, string][] = [];

    for (let i = 0; i < half; i++) {
      const home = order[i];
      const away = order[order.length - 1 - i];
      if (!home || !away || home === '__bye__' || away === '__bye__') continue;
      // Alternate which side is at home across rounds, so no team plays every
      // fixture away from home.
      pairings.push(round % 2 === 0 ? [home, away] : [away, home]);
    }

    rounds.push(pairings);
    rotating.unshift(rotating.pop() as string);
  }

  return rounds;
}

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
        match_events, result_submissions, fixture_changes, fixtures,
        venue_closures, venues, municipalities,
        person_registrations, stage_group_entries, edition_entries,
        eligibility_rules, eligibility_profiles, teams, clubs,
        honour_awards, honours, progression_rules, stage_entry_sources,
        stage_groups, stages, competition_editions, competition_series,
        ladders, seasons, registration_years, governing_bodies,
        articles, documents,
        consents, guardianships, role_grants, persons,
        audit_log, org_domains, organizations,
        two_factors, sessions, accounts, verifications, users
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
  /** Squad members per entry, so goals are credited to real registrations. */
  const squadsByEntry = new Map<string, string[]>();
  for (const entryId of entryIds) {
    const squadSize = 14 + Math.floor(rng() * 4);
    const squad: string[] = [];
    squadsByEntry.set(entryId, squad);
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
      squad.push(personId);
      playerCount++;
    }
  }

  // --- venues ---------------------------------------------------------------
  const TIMEZONE = 'America/Vancouver';

  const MUNICIPALITIES = [
    { code: 'KEL', name: 'Kelowna' },
    { code: 'WKEL', name: 'West Kelowna' },
    { code: 'LKC', name: 'Lake Country' },
    { code: 'PCH', name: 'Peachland' },
    { code: 'VER', name: 'Vernon' },
  ];

  const municipalityIds = new Map<string, string>();
  for (const [i, m] of MUNICIPALITIES.entries()) {
    const id = uuidv7();
    municipalityIds.set(m.code, id);
    await db
      .insert(schema.municipalities)
      .values({ id, orgId, code: m.code, name: m.name, sortOrder: i });
  }

  /**
   * A complex with three numbered pitches plus four standalone grounds, which
   * is what a real field list looks like. The old site flattens this into a
   * hundred and forty unrelated strings with the field number glued onto the
   * name; the parent/child link is what makes "field 3 is shut but 1 and 2 are
   * open" expressible.
   */
  const complexId = uuidv7();
  const venueIds: string[] = [];

  await db.insert(schema.venues).values({
    id: complexId,
    orgId,
    name: 'Rutland Sports Complex',
    slug: 'rutland-sports-complex',
    municipalityId: municipalityIds.get('KEL'),
    surface: 'GRASS',
    latitude: 49.8951,
    longitude: -119.3877,
    address: '1200 Houghton Road, Kelowna',
  });

  for (const pitch of [1, 2, 3]) {
    const id = uuidv7();
    venueIds.push(id);
    await db.insert(schema.venues).values({
      id,
      orgId,
      parentVenueId: complexId,
      name: `Rutland Sports Complex - Field ${pitch}`,
      slug: `rutland-field-${pitch}`,
      municipalityId: municipalityIds.get('KEL'),
      surface: pitch === 1 ? 'ARTIFICIAL_TURF' : 'GRASS',
      isFloodlit: pitch === 1,
      latitude: 49.8951 + pitch * 0.0006,
      longitude: -119.3877,
    });
  }

  const STANDALONE = [
    { name: 'Glenmore Recreation Park', code: 'KEL', surface: 'GRASS', floodlit: false },
    { name: 'Westbank Turf Field', code: 'WKEL', surface: 'ARTIFICIAL_TURF', floodlit: true },
    { name: 'Lake Country Memorial Ground', code: 'LKC', surface: 'GRASS', floodlit: false },
    { name: 'Peachland Lakeside Pitch', code: 'PCH', surface: 'GRASS', floodlit: false },
  ] as const;

  for (const venue of STANDALONE) {
    const id = uuidv7();
    venueIds.push(id);
    await db.insert(schema.venues).values({
      id,
      orgId,
      name: venue.name,
      slug: slugify(venue.name),
      municipalityId: municipalityIds.get(venue.code),
      surface: venue.surface,
      isFloodlit: venue.floodlit,
      latitude: 49.85 + rng() * 0.2,
      longitude: -119.5 + rng() * 0.3,
    });
  }

  // An open-ended closure, so the field-status banner has something to show.
  await db.insert(schema.venueClosures).values({
    orgId,
    venueId: venueIds[venueIds.length - 1] ?? complexId,
    startsAt: new Date('2026-01-05T08:00:00Z'),
    reason: 'Standing water - closed until the ground dries out.',
    source: 'District of Peachland',
  });

  // --- fixtures, results and match events -----------------------------------
  /**
   * A full single round-robin per group, played out with results.
   *
   * Two of the matchdays are chosen deliberately. 1 November 2025 and 7 March
   * 2026 are the Saturdays either side of a daylight-saving change, so the
   * seeded data exercises the conversion visibly rather than leaving it to the
   * test suite alone: if the schedule page ever renders those two weekends an
   * hour out, it shows up the first time anybody looks at the demo.
   */
  const entriesByGroup = new Map<string, string[]>();
  for (const [i, entryId] of entryIds.entries()) {
    const target = editionTargets[i % editionTargets.length];
    if (!target) continue;
    const list = entriesByGroup.get(target.groupId) ?? [];
    list.push(entryId);
    entriesByGroup.set(target.groupId, list);
  }

  const MATCHDAY_DATES = [
    '2025-09-13',
    '2025-09-27',
    '2025-10-18',
    '2025-11-01', // clocks go back at 02:00 the following morning
    '2025-11-22',
    '2026-02-07',
    '2026-03-07', // clocks go forward at 02:00 the following morning
    '2026-03-28',
    '2026-04-11',
    '2026-04-25',
  ];

  let fixtureCount = 0;
  let eventCount = 0;

  for (const groupId of entriesByGroup.keys()) {
    const groupEntries = entriesByGroup.get(groupId) ?? [];
    if (groupEntries.length < 2) continue;

    const rounds = roundRobin(groupEntries);

    for (const [matchday, pairings] of rounds.entries()) {
      /**
       * Spread the rounds across the whole campaign rather than taking the
       * first N dates.
       *
       * A four-team group is only three rounds, so consecutive indexing would
       * finish the season in October and never reach either daylight-saving
       * weekend — which is exactly what the two dates below were chosen for.
       * Striding makes the demo exercise them.
       */
      const date =
        MATCHDAY_DATES[Math.floor((matchday * MATCHDAY_DATES.length) / Math.max(rounds.length, 1))];
      if (!date) continue;

      for (const [slot, pairing] of pairings.entries()) {
        const [homeEntryId, awayEntryId] = pairing;
        const kickoffLocal = `${date}T${slot % 2 === 0 ? '14:00' : '19:00'}`;
        const venueId = venueIds[(fixtureCount + slot) % venueIds.length];
        const fixtureId = uuidv7();

        // One fixture is left postponed, so the status model is visible in the
        // demo rather than existing only in the schema.
        const postponed = fixtureCount === 5;
        const kickoffAt = postponed ? null : zonedWallTimeToInstant(kickoffLocal, TIMEZONE);

        await db.insert(schema.fixtures).values({
          id: fixtureId,
          orgId,
          stageGroupId: groupId,
          homeEntryId,
          awayEntryId,
          venueId,
          kickoffAt,
          matchday: matchday + 1,
          status: postponed ? 'POSTPONED' : 'PLAYED',
          publicNote: postponed ? 'Rearranged date to be confirmed.' : null,
        });

        await db.insert(schema.fixtureChanges).values({
          orgId,
          fixtureId,
          kind: 'SCHEDULED',
          newKickoffAt: kickoffAt,
          newVenueId: venueId,
          newStatus: postponed ? 'POSTPONED' : 'SCHEDULED',
          reason: 'Season schedule published.',
        });

        fixtureCount++;
        if (postponed) continue;

        const homeScore = Math.floor(rng() * 4);
        const awayScore = Math.floor(rng() * 4);

        await db.insert(schema.resultSubmissions).values({
          orgId,
          fixtureId,
          source: 'REFEREE',
          homeScore,
          awayScore,
        });

        // Goals credited to real squad members, so the Phase 4 leaderboards
        // have something to aggregate over.
        for (const side of [
          { entryId: homeEntryId, goals: homeScore },
          { entryId: awayEntryId, goals: awayScore },
        ]) {
          const squad = squadsByEntry.get(side.entryId) ?? [];
          for (let g = 0; g < side.goals; g++) {
            await db.insert(schema.matchEvents).values({
              orgId,
              fixtureId,
              editionEntryId: side.entryId,
              personId: squad[Math.floor(rng() * squad.length)] ?? null,
              type: 'GOAL',
              period: rng() > 0.5 ? 'SECOND_HALF' : 'FIRST_HALF',
              minute: 1 + Math.floor(rng() * 89),
            });
            eventCount++;
          }
        }

        // A card every few matches, so Phase 11 has real inputs to build on.
        if (rng() > 0.7) {
          const squad = squadsByEntry.get(homeEntryId) ?? [];
          await db.insert(schema.matchEvents).values({
            orgId,
            fixtureId,
            editionEntryId: homeEntryId,
            personId: squad[Math.floor(rng() * squad.length)] ?? null,
            type: rng() > 0.85 ? 'RED_CARD' : 'YELLOW_CARD',
            period: 'SECOND_HALF',
            minute: 46 + Math.floor(rng() * 44),
          });
          eventCount++;
        }
      }
    }
  }

  // --- published content -----------------------------------------------------
  /**
   * One of each state, so the publication rules are visible in the demo rather
   * than only in the tests: a live notice, a live report, a scheduled post that
   * must NOT appear, and an expired classified that must not either.
   */
  const now = Date.now();
  await db.insert(schema.articles).values([
    {
      orgId,
      kind: 'NEWS',
      title: 'Season kicks off this weekend',
      slug: 'season-kicks-off-this-weekend',
      summary: 'All divisions begin on Saturday. Check your fixture before travelling.',
      body:
        'The 2025-26 campaign begins this Saturday across every division.\n\n' +
        'Fixtures, kickoff times and grounds are on the schedule page, and every team ' +
        'can subscribe to a calendar feed so that any change reaches your phone.',
      publishedAt: new Date(now - 7 * 86_400_000),
      isPinned: true,
    },
    {
      orgId,
      kind: 'WEEKLY_REPORT',
      title: 'Weekly report — week one',
      slug: 'weekly-report-week-one',
      summary: 'Results, standings and discipline from the opening weekend.',
      body:
        'A full round of fixtures was played, with one postponement at Peachland ' +
        'following standing water.\n\nTables are published and update as results are confirmed.',
      publishedAt: new Date(now - 3 * 86_400_000),
    },
    {
      orgId,
      kind: 'NOTICE',
      title: 'Referees wanted',
      slug: 'referees-wanted',
      summary: 'The league is recruiting officials for the spring campaign.',
      body: 'Contact the referee assignor if you hold a current certification.',
      publishedAt: new Date(now - 86_400_000),
      // Expires, so the notice board clears itself.
      expiresAt: new Date(now + 30 * 86_400_000),
    },
    {
      orgId,
      kind: 'NEWS',
      title: 'Scheduled: this must not be visible yet',
      slug: 'scheduled-not-visible',
      body: 'If this appears on the news page, the publication filter is broken.',
      publishedAt: new Date(now + 30 * 86_400_000),
    },
    {
      orgId,
      kind: 'NOTICE',
      title: 'Expired: this must not be visible either',
      slug: 'expired-not-visible',
      body: 'If this appears on the notice board, the expiry filter is broken.',
      publishedAt: new Date(now - 60 * 86_400_000),
      expiresAt: new Date(now - 86_400_000),
    },
  ]);

  await db.insert(schema.documents).values([
    {
      orgId,
      title: 'Rules and Regulations 2025-26',
      slug: 'rules-and-regulations-2025-26',
      description: 'The competition rules, including discipline and eligibility.',
      category: 'Rules',
      url: 'https://example.invalid/kml/rules-2025-26.pdf',
      sizeLabel: '1.2 MB',
      sortOrder: 1,
      publishedAt: new Date(now - 30 * 86_400_000),
    },
    {
      orgId,
      title: 'League Constitution',
      slug: 'league-constitution',
      category: 'Governance',
      url: 'https://example.invalid/kml/constitution.pdf',
      sizeLabel: '340 KB',
      publishedAt: new Date(now - 200 * 86_400_000),
    },
    {
      orgId,
      title: 'Team Fine Schedule',
      slug: 'team-fine-schedule',
      description: 'What each offence costs a club.',
      category: 'Rules',
      url: 'https://example.invalid/kml/fines.pdf',
      sizeLabel: '90 KB',
      sortOrder: 2,
      publishedAt: new Date(now - 30 * 86_400_000),
    },
  ]);

  // --- a sign-in for the demo ------------------------------------------------
  /**
   * One league administrator, so the admin screens can actually be opened.
   *
   * Guarded three ways, because a seeded account with a known password is
   * exactly the thing that turns up in production one day:
   *
   *   - refuses outright if NODE_ENV is production
   *   - the password comes from SEED_ADMIN_PASSWORD, with a local-only default
   *   - it is announced loudly in the output rather than created quietly
   *
   * The account is created through better-auth's own API rather than by
   * inserting a row, so the password is hashed the way a real sign-up hashes
   * it. A hand-written INSERT here would produce an account that cannot log in
   * and a puzzling afternoon.
   */
  let adminEmail: string | null = null;
  let adminUsername: string | null = null;
  if (process.env.NODE_ENV === 'production') {
    console.log('  demo sign-in   skipped (NODE_ENV=production)');
  } else {
    const { auth } = await import('../src/server/auth');
    adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@kelowna.localhost';
    adminUsername = process.env.SEED_ADMIN_USERNAME ?? 'demoadmin';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'demo-password-please-change';

    const signUp = await auth.api
      .signUpEmail({
        body: {
          email: adminEmail,
          password: adminPassword,
          name: 'Demo Administrator',
          // A username as well, so both sign-in paths are exercised by the demo
          // rather than only the email one.
          username: adminUsername,
          displayUsername: adminUsername,
        },
      })
      .catch((error: unknown) => {
        console.log(`  demo sign-in   not created: ${(error as Error).message}`);
        return null;
      });

    if (signUp?.user) {
      // A person is per-league; the login is global. The grant hangs off the
      // person, which is what getPrincipal() resolves.
      const adminPersonId = uuidv7();
      await db.insert(schema.persons).values({
        id: adminPersonId,
        orgId,
        userId: signUp.user.id,
        givenName: 'Demo',
        familyName: 'Administrator',
        displayName: 'Demo Administrator',
      });

      await db.insert(schema.roleGrants).values({
        orgId,
        personId: adminPersonId,
        role: 'LEAGUE_ADMIN',
        scopeKind: 'ORGANIZATION',
        status: 'ACTIVE',
      });
    }
  }

  // --- standings ------------------------------------------------------------
  /**
   * Derived, exactly as it is in the application: the same engine, over the
   * same facts. Seeding a table by writing points totals directly would make
   * the demo agree with itself while proving nothing about the code that
   * produces it in production.
   *
   * Safe to run unscoped here only because the seed creates one league and
   * connects as superuser. Everywhere else this runs inside `withOrg`.
   */
  let standingsGroups = 0;
  await db.transaction(async (tx) => {
    for (const groupId of entriesByGroup.keys()) {
      const outcome = await recomputeStandingsWithin(tx, unsafeAsOrgId(orgId, 'seed'), groupId);
      if (outcome.snapshotId) standingsGroups++;
    }
  });

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
  console.log(`  venues          ${venueIds.length + 1}  (1 complex + ${venueIds.length} pitches)`);
  console.log(`  fixtures        ${fixtureCount}  (incl. 2 DST-boundary matchdays)`);
  console.log(`  match events    ${eventCount}`);
  console.log(`  standings       ${standingsGroups}  tables computed from those results`);
  if (adminEmail) {
    console.log('');
    console.log('  ⚠ A LEAGUE ADMINISTRATOR SIGN-IN WAS CREATED FOR THIS DEMO');
    console.log(`      ${adminEmail}  (or username "${adminUsername}")`);
    console.log(`      ${process.env.SEED_ADMIN_PASSWORD ?? 'demo-password-please-change'}`);
    console.log('      Local development only. Never seed a real deployment.');
  }
  console.log('✓ seed complete\n');
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error('\n✗ seed failed\n');
    let current: unknown = err;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      console.error(`[${depth}] ${current.name}: ${current.message}`);
      const pg = current as Error & { detail?: string; errors?: unknown[] };
      if (pg.detail) console.error(`     detail=${pg.detail}`);
      // AggregateError carries nothing useful in `message`; the real failures
      // are in `errors`, and without this the seed reports an empty string.
      for (const inner of pg.errors ?? []) {
        console.error(`     · ${inner instanceof Error ? inner.message : String(inner)}`);
      }
      current = current.cause;
    }
    await client.end().catch(() => {});
    process.exit(1);
  });
