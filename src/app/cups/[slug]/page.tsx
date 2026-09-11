import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill } from '@/components/status-pill';
import { formatKickoff } from '@/lib/time';
import { getCurrentSeason } from '@/server/services/competition';
import { getEditionBySlugs, listEditionGroups, listSeasons } from '@/server/services/directory';
import { listFixtures } from '@/server/services/fixtures';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * A cup.
 *
 * There is no `isCup` column anywhere in this schema, and this page is the
 * proof that none is needed: a cup is a competition sitting on no ladder, and
 * a knockout is a STAGE whose format says so. The rounds below are stage
 * groups, ordered by the stage's own ordinal — the same structure a division
 * uses, configured differently.
 *
 * That is why the old site's flat thirty-item dropdown, which mixed divisions,
 * cups, trophies and the words "Promotion" and "Relegation" together, has no
 * way to come back here.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ season?: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) return { title: 'Cup' };
  const { slug } = await params;
  return { title: slug.replace(/-/g, ' ') };
}

export default async function CupPage({ params, searchParams }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { slug } = await params;
  const { season: seasonSlug } = await searchParams;

  const seasons = await listSeasons(league.id);
  const current = await getCurrentSeason(league.id);
  const season = seasonSlug
    ? seasons.find((s) => s.slug === seasonSlug)
    : (seasons.find((s) => s.id === current?.id) ?? seasons[seasons.length - 1]);

  if (!season) notFound();

  const edition = await getEditionBySlugs(league.id, season.slug, slug);
  if (!edition) notFound();

  const [groups, fixtures] = await Promise.all([
    listEditionGroups(league.id, edition.editionId),
    listFixtures(league.id, { editionId: edition.editionId }),
  ]);

  const byGroup = new Map<string, typeof fixtures>();
  for (const fixture of fixtures) {
    const bucket = byGroup.get(fixture.stageGroupId);
    if (bucket) bucket.push(fixture);
    else byGroup.set(fixture.stageGroupId, [fixture]);
  }

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">{edition.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{season.name}</p>
      </header>

      <nav aria-label="Season" className="mt-6 flex flex-wrap gap-2">
        {seasons.map((s) => (
          <Link
            key={s.id}
            href={`/cups/${slug}?season=${s.slug}`}
            aria-current={s.id === season.id ? 'page' : undefined}
            className={
              s.id === season.id
                ? 'rounded-full border border-foreground px-3 py-1 text-sm font-medium'
                : 'rounded-full border px-3 py-1 text-sm text-muted-foreground hover:border-foreground hover:text-foreground'
            }
          >
            {s.name}
          </Link>
        ))}
      </nav>

      {groups.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">
          No rounds have been set up for this competition yet.
        </p>
      ) : (
        groups.map((group) => {
          const roundFixtures = byGroup.get(group.id) ?? [];
          return (
            <section key={group.id} className="mt-10">
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-lg font-medium">{group.name}</h2>
                <span className="text-sm text-muted-foreground">{group.stageName}</span>
                <a
                  href={`/api/ics/group/${group.id}.ics`}
                  className="ml-auto text-sm underline"
                >
                  Subscribe to this round
                </a>
              </div>

              {roundFixtures.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {/* A cup round exists before its ties do — that is the whole
                      reason fixtures may carry no teams yet. */}
                  Not yet drawn.
                </p>
              ) : (
                <ul className="mt-3 divide-y rounded-lg border">
                  {roundFixtures.map((fixture) => (
                    <li
                      key={fixture.id}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm"
                    >
                      <span className="font-medium">
                        {fixture.homeTeamName ?? 'To be confirmed'} v{' '}
                        {fixture.awayTeamName ?? 'To be confirmed'}
                      </span>
                      <span className="text-muted-foreground">
                        {fixture.kickoffAt
                          ? formatKickoff(fixture.kickoffAt, league.timezone, { withZone: false })
                          : 'Date to be confirmed'}
                      </span>
                      {fixture.venueName ? (
                        <span className="text-muted-foreground">{fixture.venueName}</span>
                      ) : null}
                      <span className="ml-auto">
                        {fixture.result.state === 'CONFIRMED' && fixture.result.scoreline ? (
                          <span className="font-medium tabular-nums">
                            {fixture.result.scoreline.homeScore ?? '–'}–
                            {fixture.result.scoreline.awayScore ?? '–'}
                            {fixture.result.scoreline.homePenalties !== null &&
                            fixture.result.scoreline.awayPenalties !== null ? (
                              <span className="ml-1 text-xs font-normal text-muted-foreground">
                                ({fixture.result.scoreline.homePenalties}–
                                {fixture.result.scoreline.awayPenalties} pens)
                              </span>
                            ) : null}
                          </span>
                        ) : fixture.result.state === 'DISPUTED' ? (
                          <StatusPill tone="caution">Disputed</StatusPill>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </main>
  );
}
