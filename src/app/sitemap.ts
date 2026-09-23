import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { listPublicSlugs } from '@/server/services/directory';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The sitemap, built from the league resolved by hostname.
 *
 * Each league has its own domain, so this must never be a static list: the
 * sitemap served at one league's address has to contain only that league's
 * pages, or the leagues start competing with each other in search results for
 * pages they do not own.
 *
 * Every entity page is listed because being findable is the point of having
 * given each one an address — the old site has no addressable club, team or
 * match, and consequently ranks for nothing.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const league = await getCurrentLeague();
  if (!league) return [];

  const headerList = await headers();
  const host = headerList.get('host') ?? 'localhost:3000';
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  const origin = `${protocol}://${host}`;

  const slugs = await listPublicSlugs(league.id);

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${origin}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${origin}/standings`, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${origin}/schedule`, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${origin}/schedule/week`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${origin}/fields`, changeFrequency: 'daily', priority: 0.7 },
    { url: `${origin}/clubs`, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${origin}/news`, changeFrequency: 'daily', priority: 0.7 },
    { url: `${origin}/documents`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${origin}/history`, changeFrequency: 'yearly', priority: 0.5 },
  ];

  return [
    ...staticPages,
    ...slugs.clubs.map((club) => ({
      url: `${origin}/clubs/${club.slug}`,
      lastModified: club.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...slugs.teams.map((team) => ({
      url: `${origin}/teams/${team.slug}`,
      lastModified: team.updatedAt,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
    ...slugs.editions.map((edition) => ({
      url: `${origin}/standings?season=${edition.seasonSlug}&competition=${edition.slug}`,
      lastModified: edition.updatedAt,
      changeFrequency: 'hourly' as const,
      priority: 0.8,
    })),
  ];
}
