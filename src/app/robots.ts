import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';

/**
 * Generated per host, for the same reason as the sitemap: the `Sitemap:` line
 * has to be an absolute URL, and it must point at the league being served
 * rather than at whichever hostname happened to be configured at build time.
 */
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const headerList = await headers();
  const host = headerList.get('host') ?? 'localhost:3000';
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  const origin = `${protocol}://${host}`;

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          // Not secrets — they are all public — but there is nothing for a
          // crawler in a calendar feed or a health check, and indexing them
          // wastes crawl budget that should go to the entity pages.
          '/api/',
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
