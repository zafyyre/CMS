import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/db/schema';

config({ path: '.env' });

/**
 * SAMPLE historical data, so Phase 5 can be exercised without real data.
 *
 *   npx tsx scripts/sample-history.ts [--out sample-data]
 *
 * The league's own twelve seasons cannot be harvested: vmslsoccer.com's
 * robots.txt disallows `/webapps`, and every data endpoint on that site lives
 * under it. Until the league supplies an export, the importer, the schema and
 * the standings engine have never been run against anything but unit fixtures.
 *
 * This generates three past seasons in the legacy export format and scaffolds
 * the competitions to receive them. It is NOT a substitute for real data — it
 * cannot surprise us the way twelve years of real records will, which is most
 * of Phase 5's value. What it does prove is that the pipeline runs end to end
 * and that the recompute-versus-published diff comes out clean.
 *
 * ── WHY THE EXPORT NAMES THE CLUBS WE ALREADY HAVE ──────────────────────────
 * A real legacy export describes the same league, so its clubs, teams and
 * venues are the ones already on file under the spellings the old system used.
 * Inventing twelve unrelated names would produce an import in which nothing
 * ever matches anything — which is the one path through the resolver that real
 * data will almost never take. So the roster is read back out of the database
 * and written into the export, and the resolver earns its exact-match path.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── WHY COMPETITIONS ARE SCAFFOLDED HERE AND NOT BY THE IMPORTER ────────────
 * The importer deliberately refuses to invent competitions, because doing so
 * would rebuild the old site's flat dropdown one row at a time. Deciding that
 * "Division 2, 2023-24 ran as two sections" is a modelling judgement a person
 * makes. This script makes it explicitly, in the same shape the seed does.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Connects as the SUPERUSER, like the seed and the import CLI: scaffolding a
 * historical season is an operational act, so row-level security does not
 * apply and the league is selected explicitly by slug.
 */

const flags = process.argv.slice(2);
const outIndex = flags.indexOf('--out');
const outDir = outIndex >= 0 ? (flags[outIndex + 1] ?? 'sample-data') : 'sample-data';
const orgSlug = process.env.DEFAULT_ORG_SLUG ?? 'demo';

const url = process.env.SEED_DATABASE_URL;
if (!url) throw new Error('SEED_DATABASE_URL is not set');

/** The seasons generated, oldest first. */
const SEASONS = [
  { year: '2022-23', startYear: 2022 },
  { year: '2023-24', startYear: 2023 },
  { year: '2024-25', startYear: 2024 },
] as const;

const client = new Client({ connectionString: url });

async function main() {
  await client.connect();
  const db = drizzle(client, { schema });

  const [org] = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.slug, orgSlug), isNull(schema.organizations.deletedAt)));

  if (!org) {
    throw new Error(`No league with slug "${orgSlug}". Set DEFAULT_ORG_SLUG, or seed one first.`);
  }
  const orgId = org.id;

  // --- the roster the export will describe ----------------------------------
  const teamRows = await db
    .select({ teamName: schema.teams.name, clubName: schema.clubs.name })
    .from(schema.teams)
    .innerJoin(schema.clubs, eq(schema.teams.clubId, schema.clubs.id))
    .where(and(eq(schema.teams.orgId, orgId), isNull(schema.teams.deletedAt)))
    .orderBy(asc(schema.teams.name));

  const venueRows = await db
    .select({ name: schema.venues.name })
    .from(schema.venues)
    .where(and(eq(schema.venues.orgId, orgId), isNull(schema.venues.deletedAt)))
    .orderBy(asc(schema.venues.name));

  if (teamRows.length < 12) {
    throw new Error(
      `Only ${teamRows.length} teams exist, which is too few to fill a division and two ` +
        'sections. Run `npm run db:seed:reset` first.',
    );
  }

  console.log(`\n▸ ${org.name}: ${teamRows.length} teams, ${venueRows.length} venues on file`);

  mkdirSync(outDir, { recursive: true });

  for (const [index, season] of SEASONS.entries()) {
    const built = await scaffoldSeason(db, orgId, season);
    const file = join(outDir, `${season.year}.json`);
    const exported = buildExport(season, index, teamRows, venueRows, built);
    writeFileSync(file, `${JSON.stringify(exported, null, 2)}\n`, { encoding: 'utf8' });

    console.log(
      `  ${season.year}  ${exported.fixtures.length} fixtures, ` +
        `${exported.standings.length} tables  →  ${file}`,
    );
  }

  console.log('\n  Import them oldest first — the first season teaches the resolver the names:\n');
  for (const season of SEASONS) {
    console.log(`    npx tsx scripts/import-legacy.ts ${join(outDir, `${season.year}.json`)} --promote`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Scaffolding — the modelling decisions the importer refuses to make
// ---------------------------------------------------------------------------

interface BuiltSeason {
  premierKey: string;
  divisionKey: string;
  sectionKeys: [string, string];
}

/**
 * One past season: a registration year, a campaign, and two competitions —
 * Premier as a single table, Division 2 split into two sections.
 *
 * Idempotent by slug, so a re-run after a partial failure does not duplicate.
 *
 * ── WHY THE EDITION SLUGS CARRY THE YEAR ────────────────────────────────────
 * The importer resolves a competitionKey through a map built from each
 * edition's slug, its series' slug, and its series' NAME. Those last two are
 * identical across every season a series has ever run, so the map silently
 * overwrites and "Premier Division" resolves to whichever edition the database
 * returned last. Naming each edition `premier-2023-24` keeps the key unique and
 * the lookup unambiguous. (The collision itself is a real defect in the
 * importer, reported separately — this only avoids tripping over it.)
 * ────────────────────────────────────────────────────────────────────────────
 */
async function scaffoldSeason(
  db: ReturnType<typeof drizzle<typeof schema, Client>>,
  orgId: string,
  season: (typeof SEASONS)[number],
): Promise<BuiltSeason> {
  const { year, startYear } = season;
  const premierKey = `premier-${year}`;
  const divisionKey = `division-2-${year}`;

  const seasonSlug = `autumn-winter-${year}`;
  const [existingSeason] = await db
    .select({ id: schema.seasons.id })
    .from(schema.seasons)
    .where(
      and(
        eq(schema.seasons.orgId, orgId),
        eq(schema.seasons.slug, seasonSlug),
        isNull(schema.seasons.deletedAt),
      ),
    );

  if (existingSeason) {
    return { premierKey, divisionKey, sectionKeys: ['section-a', 'section-b'] };
  }

  const regYearId = uuidv7();
  await db.insert(schema.registrationYears).values({
    id: regYearId,
    orgId,
    label: year,
    slug: year,
    startsOn: `${startYear}-07-01`,
    endsOn: `${startYear + 1}-06-30`,
  });

  const seasonId = uuidv7();
  await db.insert(schema.seasons).values({
    id: seasonId,
    orgId,
    registrationYearId: regYearId,
    name: `Autumn/Winter ${year}`,
    slug: seasonSlug,
    ordinalInYear: 1,
    startsOn: `${startYear}-09-03`,
    endsOn: `${startYear + 1}-04-27`,
    status: 'COMPLETED',
  });

  // The series already exist — a series is perpetual, which is the whole point
  // of the model. Only the editions are new.
  const series = await db
    .select({ id: schema.competitionSeries.id, slug: schema.competitionSeries.slug })
    .from(schema.competitionSeries)
    .where(and(eq(schema.competitionSeries.orgId, orgId), isNull(schema.competitionSeries.deletedAt)));

  const premierSeriesId = series.find((s) => s.slug === 'premier')?.id;
  const div2SeriesId = series.find((s) => s.slug === 'division-2')?.id;
  if (!premierSeriesId || !div2SeriesId) {
    throw new Error('The Premier and Division 2 series must exist. Run `npm run db:seed:reset`.');
  }

  const premierEdId = uuidv7();
  const div2EdId = uuidv7();
  await db.insert(schema.competitionEditions).values([
    {
      id: premierEdId,
      orgId,
      seriesId: premierSeriesId,
      seasonId,
      slug: premierKey,
      tier: 1,
      status: 'COMPLETED',
    },
    {
      id: div2EdId,
      orgId,
      seriesId: div2SeriesId,
      seasonId,
      slug: divisionKey,
      tier: 3,
      status: 'COMPLETED',
    },
  ]);

  const premierStageId = uuidv7();
  const div2StageId = uuidv7();
  await db.insert(schema.stages).values([
    {
      id: premierStageId,
      orgId,
      editionId: premierEdId,
      ordinal: 1,
      name: 'Regular Season',
      slug: 'regular',
      format: 'ROUND_ROBIN',
      legsPerPairing: 2,
    },
    {
      id: div2StageId,
      orgId,
      editionId: div2EdId,
      ordinal: 1,
      name: 'Sections',
      slug: 'sections',
      format: 'ROUND_ROBIN',
      legsPerPairing: 2,
    },
  ]);

  await db.insert(schema.stageGroups).values([
    { orgId, stageId: premierStageId, name: 'Premier Division', slug: 'table', ordinal: 1 },
    { orgId, stageId: div2StageId, name: 'Section A', slug: 'section-a', ordinal: 1 },
    { orgId, stageId: div2StageId, name: 'Section B', slug: 'section-b', ordinal: 2 },
  ]);

  return { premierKey, divisionKey, sectionKeys: ['section-a', 'section-b'] };
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

interface RosterTeam {
  teamName: string;
  clubName: string;
}

interface LegacyFixtureOut {
  key: string;
  competitionKey: string;
  groupKey?: string;
  homeTeamKey: string;
  awayTeamKey: string;
  date: string;
  time: string;
  venueKey?: string;
  round: number;
  matchday: number;
  homeScore: number;
  awayScore: number;
  status: 'PLAYED';
}

function buildExport(
  season: (typeof SEASONS)[number],
  seasonIndex: number,
  roster: readonly RosterTeam[],
  venues: readonly { name: string }[],
  built: BuiltSeason,
) {
  const rng = mulberry32(0x5eed + seasonIndex * 977);

  /**
   * Who played where. Rotated by one place per season, so a team moves between
   * Premier and Division 2 across the three years exactly as promotion and
   * relegation would move it — which is the case `tier` on the EDITION exists
   * to express, and a case a single-season sample would never reach.
   */
  const rotated = [...roster.slice(seasonIndex), ...roster.slice(0, seasonIndex)];
  const premierSize = Math.min(8, Math.max(4, Math.floor(rotated.length / 2)));
  const premier = rotated.slice(0, premierSize);
  const rest = rotated.slice(premierSize);
  const sectionSize = Math.min(6, Math.floor(rest.length / 2));
  const sectionA = rest.slice(0, sectionSize);
  const sectionB = rest.slice(sectionSize, sectionSize * 2);

  const divisions = [
    { teams: premier, competitionKey: built.premierKey, groupKey: undefined, label: 'premier' },
    { teams: sectionA, competitionKey: built.divisionKey, groupKey: built.sectionKeys[0], label: 'sec-a' },
    { teams: sectionB, competitionKey: built.divisionKey, groupKey: built.sectionKeys[1], label: 'sec-b' },
  ] as const;

  const playing = [...premier, ...sectionA, ...sectionB];
  const clubNames = [...new Set(playing.map((t) => t.clubName))];

  const fixtures: LegacyFixtureOut[] = [];
  const standings: {
    key: string;
    competitionKey: string;
    groupKey?: string;
    rows: ReturnType<typeof publishedTable>;
  }[] = [];

  for (const division of divisions) {
    if (division.teams.length < 4) continue;

    const played = scheduleDoubleRoundRobin(
      division.teams.map((t) => t.teamName),
      rng,
    );

    played.forEach((match, i) => {
      fixtures.push({
        key: `${season.year}-${division.label}-${String(i + 1).padStart(3, '0')}`,
        competitionKey: division.competitionKey,
        ...(division.groupKey ? { groupKey: division.groupKey } : {}),
        homeTeamKey: match.home,
        awayTeamKey: match.away,
        ...matchdayDate(season.startYear, match.round),
        ...(venues.length > 0
          ? { venueKey: (venues[i % venues.length] as { name: string }).name }
          : {}),
        round: match.round,
        matchday: match.round,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        status: 'PLAYED' as const,
      });
    });

    standings.push({
      key: `${season.year}-${division.label}-table`,
      competitionKey: division.competitionKey,
      ...(division.groupKey ? { groupKey: division.groupKey } : {}),
      rows: publishedTable(
        division.teams.map((t) => t.teamName),
        played,
      ),
    });
  }

  const premierChampion = standings[0]?.rows[0]?.teamName;

  return {
    version: 1 as const,
    source: `Sample historical export — Autumn/Winter ${season.year} (generated, not real data)`,
    clubs: clubNames.map((name) => ({ key: name, name })),
    teams: playing.map((t) => ({ key: t.teamName, name: t.teamName, clubKey: t.clubName })),
    venues: venues.map((v) => ({ key: v.name, name: v.name })),
    fixtures,
    standings,
    honours: premierChampion
      ? [
          {
            key: `${season.year}-founders`,
            honourName: "The Founders' Trophy",
            recipientName: premierChampion,
            awardedOn: `${season.startYear + 1}-05-10`,
          },
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface PlayedMatch {
  home: string;
  away: string;
  round: number;
  homeScore: number;
  awayScore: number;
}

/**
 * A full double round-robin by the circle method, with the reverse half's
 * venues swapped. Every pair meets exactly twice, once at each ground.
 */
function scheduleDoubleRoundRobin(teams: readonly string[], rng: () => number): PlayedMatch[] {
  // An odd count gets a bye, which sits out one round per cycle.
  const wheel: (string | null)[] = teams.length % 2 === 0 ? [...teams] : [...teams, null];
  const half = wheel.length / 2;
  const rounds = wheel.length - 1;
  const matches: PlayedMatch[] = [];

  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < half; i++) {
      const home = wheel[i];
      const away = wheel[wheel.length - 1 - i];
      if (!home || !away) continue;

      // Alternate which side is nominally at home, so no team plays every
      // first-half fixture away from home.
      const flip = (round + i) % 2 === 0;
      const [h, a] = flip ? [home, away] : [away, home];

      matches.push({ home: h, away: a, round: round + 1, ...score(rng) });
      // The reverse fixture, in the second half of the season.
      matches.push({ home: a, away: h, round: round + 1 + rounds, ...score(rng) });
    }

    // Rotate all but the first position.
    const fixed = wheel[0] as string | null;
    const rest = wheel.slice(1);
    const last = rest.pop() as string | null;
    wheel.length = 0;
    wheel.push(fixed, last, ...rest);
  }

  return matches.sort((a, b) => a.round - b.round);
}

/**
 * A plausible scoreline. Home advantage is real and worth reproducing: a
 * generator that draws both sides from the same distribution produces a table
 * in which home and away records are identical, which is the one thing a real
 * season never looks like.
 */
function score(rng: () => number): { homeScore: number; awayScore: number } {
  const goals = (mean: number): number => {
    let n = 0;
    while (rng() < mean / (mean + 1 + n) && n < 6) n++;
    return n;
  };
  return { homeScore: goals(1.6), awayScore: goals(1.1) };
}

/**
 * Weekly matchdays from early September, so a season spans the November DST
 * boundary and the import exercises the wall-time conversion rather than
 * agreeing with it by accident. Kickoffs are league-local; the importer
 * converts them through the league's zone.
 */
function matchdayDate(startYear: number, round: number): { date: string; time: string } {
  const first = Date.UTC(startYear, 8, 3); // 3 September
  const day = new Date(first + (round - 1) * 7 * 86_400_000);
  const iso = day.toISOString().slice(0, 10);
  return { date: iso, time: round % 3 === 0 ? '12:00' : '14:00' };
}

/** Deterministic, so a regenerated file is byte-identical. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The published table
// ---------------------------------------------------------------------------

interface PublishedOut {
  teamName: string;
  position: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

/**
 * The table as "the source published it".
 *
 * ── WHY THIS IS WRITTEN OUT LONGHAND RATHER THAN CALLING THE ENGINE ─────────
 * The recompute-versus-published diff is only worth running if the two sides
 * are arrived at independently. Generating the published table by calling
 * `computeStandings` would make the comparison a tautology: it would agree
 * with itself no matter how wrong both were.
 *
 * So this is a second, deliberately separate implementation of the same
 * rulebook — three points for a win, then goal difference, goals for,
 * head-to-head points, wins. Two implementations agreeing is evidence; one
 * implementation agreeing with itself is not.
 *
 * It partitions recursively rather than sorting with a comparator, for the
 * reason the engine documents: head-to-head depends on WHICH teams are level,
 * which no two-argument comparison function can see.
 * ────────────────────────────────────────────────────────────────────────────
 */
function publishedTable(teams: readonly string[], matches: readonly PlayedMatch[]): PublishedOut[] {
  const tally = new Map<string, Omit<PublishedOut, 'position'>>(
    teams.map((teamName) => [
      teamName,
      { teamName, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, points: 0 },
    ]),
  );

  for (const match of matches) {
    const home = tally.get(match.home);
    const away = tally.get(match.away);
    if (!home || !away) continue;

    home.played++;
    away.played++;
    home.goalsFor += match.homeScore;
    home.goalsAgainst += match.awayScore;
    away.goalsFor += match.awayScore;
    away.goalsAgainst += match.homeScore;

    if (match.homeScore > match.awayScore) {
      home.won++;
      away.lost++;
      home.points += 3;
    } else if (match.homeScore < match.awayScore) {
      away.won++;
      home.lost++;
      away.points += 3;
    } else {
      home.drawn++;
      away.drawn++;
      home.points += 1;
      away.points += 1;
    }
  }

  const ordered = separate([...tally.values()], ['GD', 'GF', 'H2H', 'WINS'], matches);
  return ordered.map((row, index) => ({ ...row, position: index + 1 }));
}

type Criterion = 'GD' | 'GF' | 'H2H' | 'WINS';
type Tallied = Omit<PublishedOut, 'position'>;

/** Split on points, then hand each level group to the tiebreakers in turn. */
function separate(
  rows: Tallied[],
  criteria: readonly Criterion[],
  matches: readonly PlayedMatch[],
): Tallied[] {
  return groupBy(rows, (r) => r.points).flatMap((group) =>
    group.length === 1 ? group : applyCriteria(group, criteria, matches),
  );
}

function applyCriteria(
  group: Tallied[],
  criteria: readonly Criterion[],
  matches: readonly PlayedMatch[],
): Tallied[] {
  if (group.length <= 1) return group;

  const [head, ...tail] = criteria;
  if (head === undefined) {
    // Out of rulebook. Alphabetical, matching the engine's final fallback.
    return [...group].sort((a, b) => a.teamName.localeCompare(b.teamName, 'en'));
  }

  const measure = measureFor(head, group, matches);
  const split = groupBy(group, measure);

  // This criterion separated nobody; move on without claiming it did.
  if (split.length === 1) return applyCriteria(group, tail, matches);

  return split.flatMap((sub) => (sub.length === 1 ? sub : applyCriteria(sub, tail, matches)));
}

function measureFor(
  criterion: Criterion,
  group: readonly Tallied[],
  matches: readonly PlayedMatch[],
): (row: Tallied) => number {
  if (criterion === 'GD') return (r) => r.goalsFor - r.goalsAgainst;
  if (criterion === 'GF') return (r) => r.goalsFor;
  if (criterion === 'WINS') return (r) => r.won;

  // Head-to-head, over only the teams still level at this point.
  const names = new Set(group.map((r) => r.teamName));
  const mini = new Map<string, number>([...names].map((n) => [n, 0]));
  for (const match of matches) {
    if (!names.has(match.home) || !names.has(match.away)) continue;
    if (match.homeScore > match.awayScore) {
      mini.set(match.home, (mini.get(match.home) ?? 0) + 3);
    } else if (match.homeScore < match.awayScore) {
      mini.set(match.away, (mini.get(match.away) ?? 0) + 3);
    } else {
      mini.set(match.home, (mini.get(match.home) ?? 0) + 1);
      mini.set(match.away, (mini.get(match.away) ?? 0) + 1);
    }
  }
  return (r) => mini.get(r.teamName) ?? 0;
}

/** Runs of equal measure, best first, alphabetical within a run. */
function groupBy(rows: readonly Tallied[], measure: (row: Tallied) => number): Tallied[][] {
  const sorted = [...rows].sort((a, b) => {
    const delta = measure(b) - measure(a);
    return delta !== 0 ? delta : a.teamName.localeCompare(b.teamName, 'en');
  });

  const groups: Tallied[][] = [];
  let current: Tallied[] = [];
  let key: number | null = null;

  for (const row of sorted) {
    const value = measure(row);
    if (key === null || value === key) {
      current.push(row);
      key = value;
    } else {
      groups.push(current);
      current = [row];
      key = value;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error('\n✗ sample history failed\n');
    let current: unknown = err;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      console.error(`[${depth}] ${current.name}: ${current.message}`);
      const withDetail = current as Error & { detail?: string };
      if (withDetail.detail) console.error(`     detail=${withDetail.detail}`);
      current = current.cause;
    }
    await client.end().catch(() => {});
    process.exit(1);
  });
