import { permanentRedirect } from 'next/navigation';

/**
 * `/standings/[season]/[division]` — the URL shape the build plan specifies.
 *
 * The page itself lives at `/standings`, which reads the same two values from
 * the query string, because that is what the season and competition pickers
 * produce as ordinary links. Rather than render the table in two places and
 * have them drift, this path REDIRECTS to the canonical one.
 *
 * Permanent rather than temporary: there is one address for a table, and
 * telling crawlers so is the whole point of having a canonical form. Both
 * spellings stay valid for anyone who has bookmarked or printed either.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ season: string; division: string }>;
}

export default async function StandingsBySeasonAndDivision({ params }: PageProps) {
  const { season, division } = await params;

  // Encoded, because these arrive from the URL and go back into one. A slug
  // containing `&` would otherwise inject a third parameter.
  permanentRedirect(
    `/standings?season=${encodeURIComponent(season)}&competition=${encodeURIComponent(division)}`,
  );
}
