import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { listHonoursBoard } from '@/server/services/competition';
import { listSeasons } from '@/server/services/directory';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The honours board.
 *
 * This page is why trophies are entities with a lineage rather than a text
 * column on a division. On the previous schema "who won the William Azzi in
 * 2019" was not expressible at all; here it is an ordinary query, and a league
 * founded in 1974 gets to look like one.
 *
 * It is also, bluntly, what gives a league site its authority. The archive is
 * not optional colour — it is the thing that distinguishes a league's own site
 * from a fixtures app.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'History',
  description: 'Champions, trophies and past seasons.',
};

export default async function HistoryPage() {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const [honours, seasons] = await Promise.all([
    listHonoursBoard(league.id),
    listSeasons(league.id),
  ]);

  const teamHonours = honours.filter((h) => h.recipientKind === 'TEAM');
  const personHonours = honours.filter((h) => h.recipientKind === 'PERSON');

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">History</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every trophy this league awards, and who has won it.
        </p>
      </header>

      <HonourSection title="Team trophies" honours={teamHonours} />
      <HonourSection title="Individual awards" honours={personHonours} />

      <section className="mt-10">
        <h2 className="text-lg font-medium">Seasons</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {[...seasons].reverse().map((season) => (
            <li key={season.id} className="rounded-lg border px-4 py-3 text-sm">
              <Link href={`/standings?season=${season.slug}`} className="font-medium hover:underline">
                {season.name}
              </Link>
              <span className="ml-2 text-xs uppercase tracking-wide text-muted-foreground">
                {season.status.toLowerCase().replace(/_/g, ' ')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function HonourSection({
  title,
  honours,
}: {
  title: string;
  honours: Awaited<ReturnType<typeof listHonoursBoard>>;
}) {
  if (honours.length === 0) return null;

  return (
    <section className="mt-10">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {honours.map((honour) => (
          <article key={honour.id} className="rounded-lg border p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-medium">{honour.name}</h3>
              {honour.establishedYear ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  since {honour.establishedYear}
                </span>
              ) : null}
            </div>

            {honour.winners.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No winners recorded yet.</p>
            ) : (
              <ol className="mt-3 space-y-1 text-sm">
                {honour.winners.map((winner, index) => (
                  <li key={`${honour.id}-${index}`} className="flex justify-between gap-3">
                    <span>{winner.recipient}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {winner.value !== null ? `${winner.value} · ` : ''}
                      {winner.awardedOn?.slice(0, 4) ?? ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
