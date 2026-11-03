import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/site/page-frame';
import { PageHeading } from '@/components/ui/page-heading';
import { listClubs } from '@/server/services/competition';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The club index — the entry point to every club's own page.
 *
 * Sorted by name and shown in full rather than paginated: a league has of the
 * order of forty clubs, and a search box in front of forty items is a barrier
 * rather than a feature.
 *
 * It does accept `?q=`, though, because the site header's search box submits
 * here: from any page, typing part of a club's name is the fastest way to it.
 * Matching is a plain case-insensitive substring of the club's name.
 */
export const dynamic = 'force-dynamic';

type ClubsSearchParams = Promise<{ q?: string | string[] }>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: ClubsSearchParams;
}): Promise<Metadata> {
  const { q } = await searchParams;
  return {
    title: 'Clubs',
    description: 'Every club in the league.',
    // A search result is not a page of its own. Every `?q=` is a different
    // address, and search engines should index the one list, not endless
    // copies of it — while still following the links to each club.
    ...(q ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function ClubsPage({ searchParams }: { searchParams: ClubsSearchParams }) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { q } = await searchParams;
  // Capped, because the query is echoed back into the page: no club's name is
  // anywhere near this long, and an address carrying a novel should not be
  // able to fill the screen with it.
  const query = (Array.isArray(q) ? q[0] : q)?.trim().slice(0, 100) ?? '';
  const needle = query.toLocaleLowerCase();

  const all = await listClubs(league.id);
  const clubs = needle ? all.filter((club) => club.name.toLocaleLowerCase().includes(needle)) : all;

  return (
    <PageFrame>
      <PageHeading
        title="Clubs"
        description={
          query ? (
            <>
              {clubs.length} {clubs.length === 1 ? 'club' : 'clubs'} matching “{query}” ·{' '}
              <Link href="/clubs" className="underline">
                show all
              </Link>
            </>
          ) : (
            <>
              {clubs.length} clubs, {clubs.reduce((sum, c) => sum + c.teamCount, 0)} sides
            </>
          )
        }
      />

      {query && clubs.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">No club’s name contains “{query}”.</p>
      ) : null}

      <ul className="mt-8 grid gap-2 sm:grid-cols-2">
        {clubs.map((club) => (
          <li key={club.id} className="rounded-lg border px-4 py-3">
            <Link href={`/clubs/${club.slug}`} className="font-medium hover:underline">
              {club.name}
            </Link>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {club.teamCount} {club.teamCount === 1 ? 'side' : 'sides'}
              {club.foundedYear ? ` · founded ${club.foundedYear}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </PageFrame>
  );
}
