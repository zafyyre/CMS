import Link from 'next/link';
import { notFound } from 'next/navigation';
import { leagueThemeStyle } from '@/components/league-theme';
import { type DocumentSummary, listDocuments } from '@/server/services/content';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The league's documents: constitution, rules, fine schedule, forms.
 *
 * Grouped by category and, unlike the old site, each one carrying its size —
 * a 40MB rulebook opened on mobile data at a pitch is a genuine cost to
 * somebody, and it takes one column to warn them.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Documents',
  description: 'Rules, constitution, forms and other league documents.',
};

export default async function DocumentsPage() {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const documents = await listDocuments(league.id);
  const grouped = groupByCategory(documents);

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/" className="hover:underline">
          {league.shortName ?? league.slug}
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Rules, the constitution, fine schedules and registration forms.
        </p>
      </header>

      {grouped.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">
          No documents have been published yet.
        </p>
      ) : (
        grouped.map(({ category, items }) => (
          <section key={category} className="mt-10">
            <h2 className="text-lg font-medium">{category}</h2>
            <ul className="mt-3 divide-y rounded-lg border">
              {items.map((document) => (
                <li key={document.id} className="px-4 py-3">
                  <a
                    href={document.url}
                    className="font-medium hover:underline"
                    // The URL points off-site. `noopener` denies the opened page
                    // access to `window.opener`; `noreferrer` stops the league's
                    // internal paths leaking in the Referer header.
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {document.title}
                  </a>
                  {document.sizeLabel ? (
                    <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                      {document.sizeLabel}
                    </span>
                  ) : null}
                  {document.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{document.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}

function groupByCategory(
  documents: DocumentSummary[],
): { category: string; items: DocumentSummary[] }[] {
  const grouped = new Map<string, DocumentSummary[]>();
  for (const document of documents) {
    const key = document.category ?? 'General';
    const bucket = grouped.get(key);
    if (bucket) bucket.push(document);
    else grouped.set(key, [document]);
  }
  // listDocuments already orders by category, so map insertion order is right.
  return [...grouped.entries()].map(([category, items]) => ({ category, items }));
}
