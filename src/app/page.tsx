import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill } from '@/components/status-pill';
import {
  countEntries,
  getCurrentSeason,
  listClubs,
  listCompetitions,
  listHonoursBoard,
} from '@/server/services/competition';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The league's front page.
 *
 * Designed against the old site's central failure: it is a report generator
 * wrapped in a mandatory query form. You had to pick a registration year, then
 * a division from a flat list of thirty items that mixed divisions, cups and
 * trophy names together, then a "schedule type" — before seeing anything at all.
 *
 * Here the current season is simply assumed, because the data knows which one
 * is in progress. Nothing is filtered before something is shown. Every item is
 * a real thing with its own address rather than a row in a report.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const league = await getCurrentLeague();

  if (!league) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">No league configured</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No league matches this hostname. Run <code className="font-mono">npm run db:seed</code>,
          or set <code className="font-mono">DEFAULT_ORG_SLUG</code> in{' '}
          <code className="font-mono">.env</code>.
        </p>
      </main>
    );
  }

  const season = await getCurrentSeason(league.id);
  const [competitions, clubs, honours, entryCount] = await Promise.all([
    season ? listCompetitions(league.id, season.id) : Promise.resolve([]),
    listClubs(league.id),
    listHonoursBoard(league.id),
    season ? countEntries(league.id, season.id) : Promise.resolve(0),
  ]);

  const leagues = competitions.filter((c) => !c.isCup);
  const cups = competitions.filter((c) => c.isCup);

  return (
    // The league seeds only hue and chroma; lightness stays fixed so a league
    // cannot pick a brand colour that breaks contrast for its own members.
    <main className="mx-auto max-w-5xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <header className="border-b pb-6">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {league.shortName ?? league.slug}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{league.name}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {season ? (
            <>
              <span className="font-medium">{season.name}</span>
              <StatusPill tone={season.status === 'IN_PROGRESS' ? 'positive' : 'info'}>
                {season.status === 'IN_PROGRESS' ? 'Season under way' : 'Not started'}
              </StatusPill>
            </>
          ) : (
            <StatusPill tone="caution">No season configured</StatusPill>
          )}
        </div>
      </header>

      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Clubs" value={clubs.length} />
        <Stat label="Teams" value={clubs.reduce((s, c) => s + c.teamCount, 0)} />
        <Stat label="Competitions" value={competitions.length} />
        <Stat label="Entries" value={entryCount} />
      </section>

      <Section title="Divisions" hint="Ordered by tier. Promotion and relegation are data, not prose.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Division</th>
                <th className="py-2 pr-4 font-medium">Ladder</th>
                <th className="py-2 pr-4 font-medium">Structure</th>
                <th className="py-2 pr-4 text-right font-medium">Teams</th>
              </tr>
            </thead>
            <tbody>
              {leagues.map((c) => (
                <tr key={c.editionId} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium">
                    {c.name}
                    {c.tier ? (
                      <span className="ml-2 text-xs text-muted-foreground">tier {c.tier}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">{c.ladderName ?? '—'}</td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {c.groupNames.length > 1 ? c.groupNames.join(' · ') : 'Single table'}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{c.teamCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {cups.length > 0 ? (
        <Section title="Cups" hint="A cup is simply a competition that sits on no ladder.">
          <ul className="grid gap-2 sm:grid-cols-2">
            {cups.map((c) => (
              <li key={c.editionId} className="rounded-lg border px-4 py-3 text-sm">
                <span className="font-medium">{c.name}</span>
                <span className="ml-2 text-muted-foreground tabular-nums">
                  {c.teamCount} {c.teamCount === 1 ? 'entry' : 'entries'}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Honours"
        hint="Each trophy is an entity with a lineage — not a label on a division."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {honours.map((h) => (
            <div key={h.id} className="rounded-lg border p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-medium">{h.name}</h3>
                {h.establishedYear ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    since {h.establishedYear}
                  </span>
                ) : null}
              </div>
              {h.winners.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No winners recorded yet.</p>
              ) : (
                <ol className="mt-3 space-y-1 text-sm">
                  {h.winners.slice(0, 4).map((w, i) => (
                    <li key={`${h.id}-${i}`} className="flex justify-between gap-3">
                      <span>{w.recipient}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {w.value !== null ? `${w.value} · ` : ''}
                        {w.awardedOn?.slice(0, 4) ?? ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Clubs">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {clubs.map((club) => (
            <li key={club.id} className="rounded-lg border px-3 py-2 text-sm">
              <span className="font-medium">{club.name}</span>
              <span className="ml-2 text-muted-foreground tabular-nums">
                {club.teamCount} {club.teamCount === 1 ? 'side' : 'sides'}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-4">
      {/* Tabular numerals: proportional digits in a data table look amateurish
          and are measurably harder to scan down a column. */}
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-medium">{title}</h2>
      {hint ? <p className="mt-1 mb-3 text-sm text-muted-foreground">{hint}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}
