import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { formatKickoff } from '@/lib/time';
import { getArticleBySlug } from '@/server/services/content';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * One article.
 *
 * The body is rendered as plain text with paragraph breaks, NOT as HTML and not
 * through a markdown renderer. That is a deliberate limit: this content is
 * written by league volunteers into a textarea, and the moment it is rendered
 * as markup, an unescaped paste from Word becomes a stored XSS on the league's
 * own front page. Rich text can arrive later with a sanitiser chosen on
 * purpose; it should not arrive by accident.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) return { title: 'News' };
  const { slug } = await params;
  const article = await getArticleBySlug(league.id, slug);
  if (!article) return { title: 'Not found' };

  return {
    title: article.title,
    description: article.summary ?? undefined,
    openGraph: { title: article.title, description: article.summary ?? undefined, type: 'article' },
  };
}

export default async function ArticlePage({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { slug } = await params;
  const article = await getArticleBySlug(league.id, slug);
  if (!article) notFound();

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href="/news" className="hover:underline">
          News
        </Link>
      </nav>

      <article className="mt-1">
        <header className="border-b pb-6">
          <h1 className="text-3xl font-semibold tracking-tight">{article.title}</h1>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-muted-foreground">
            {article.publishedAt ? (
              <time dateTime={article.publishedAt.toISOString()} className="tabular-nums">
                {formatKickoff(article.publishedAt, league.timezone, { withZone: false })}
              </time>
            ) : null}
            {article.authorName ? <span>{article.authorName}</span> : null}
          </div>
        </header>

        {/* Split on blank lines and rendered as text nodes. React escapes each
            one, so nothing a volunteer pastes can become markup. */}
        <div className="mt-6 space-y-4 text-sm leading-relaxed">
          {article.body
            .split(/\n\s*\n/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean)
            .map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
        </div>
      </article>
    </main>
  );
}
