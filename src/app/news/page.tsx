import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { formatKickoff } from '@/lib/time';
import { type ArticleKind, listArticles } from '@/server/services/content';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * News, notices and weekly reports.
 *
 * One page rather than three, because they are one thing with three
 * lifecycles. On the old site the notice board, the weekly reports and the
 * general announcements live in three unrelated places, which is why nobody
 * reads two of them.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'News',
  description: 'Announcements, notices and weekly reports from the league.',
};

const KIND_LABELS: Record<ArticleKind, string> = {
  NEWS: 'News',
  NOTICE: 'Notice board',
  WEEKLY_REPORT: 'Weekly report',
};

interface PageProps {
  searchParams: Promise<{ kind?: string }>;
}

export default async function NewsPage({ searchParams }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { kind } = await searchParams;
  const selected = (['NEWS', 'NOTICE', 'WEEKLY_REPORT'] as const).find((k) => k === kind);
  const articles = await listArticles(league.id, { kind: selected });

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">News</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Announcements, the notice board and weekly reports.
        </p>
      </header>

      <nav aria-label="Filter" className="mt-6 flex flex-wrap gap-2">
        <Link
          href="/news"
          aria-current={!selected ? 'page' : undefined}
          className={pill(!selected)}
        >
          Everything
        </Link>
        {(['NEWS', 'NOTICE', 'WEEKLY_REPORT'] as const).map((k) => (
          <Link
            key={k}
            href={`/news?kind=${k}`}
            aria-current={selected === k ? 'page' : undefined}
            className={pill(selected === k)}
          >
            {KIND_LABELS[k]}
          </Link>
        ))}
      </nav>

      {articles.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">Nothing published yet.</p>
      ) : (
        <ul className="mt-8 space-y-4">
          {articles.map((article) => (
            <li key={article.id} className="rounded-lg border p-5">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {KIND_LABELS[article.kind]}
                </span>
                {article.isPinned ? (
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Pinned
                  </span>
                ) : null}
                {article.publishedAt ? (
                  <time
                    dateTime={article.publishedAt.toISOString()}
                    className="text-xs tabular-nums text-muted-foreground"
                  >
                    {formatKickoff(article.publishedAt, league.timezone, { withZone: false })}
                  </time>
                ) : null}
              </div>

              <h2 className="mt-1 text-lg font-medium">
                <Link href={`/news/${article.slug}`} className="hover:underline">
                  {article.title}
                </Link>
              </h2>
              {article.summary ? (
                <p className="mt-1 text-sm text-muted-foreground">{article.summary}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const pill = (active: boolean) =>
  active
    ? 'rounded-full border border-foreground px-3 py-1 text-sm font-medium'
    : 'rounded-full border px-3 py-1 text-sm text-muted-foreground hover:border-foreground hover:text-foreground';
