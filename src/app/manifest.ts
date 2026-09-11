import type { MetadataRoute } from 'next';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * The PWA manifest, generated per league rather than served as a static file.
 *
 * This is a multi-tenant product where each league has its own domain, so a
 * single `public/manifest.json` would install every league's app under one
 * name. Generating it from the resolved hostname means the installed icon on a
 * player's home screen says their league's name.
 *
 * `display: 'standalone'` is what makes it feel like an app rather than a
 * bookmark; `start_url` points at the standings because that is what somebody
 * opens the app to see.
 */
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const league = await getCurrentLeague();
  const name = league?.name ?? 'League';
  const shortName = league?.shortName ?? league?.slug ?? 'League';

  return {
    name,
    short_name: shortName,
    description: `Fixtures, results and standings for ${name}.`,
    start_url: '/standings',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // Fixed rather than themed: the accent colour is tenant-controlled and the
    // browser chrome has no contrast guarantee to fall back on.
    background_color: '#ffffff',
    theme_color: '#0f172a',
    categories: ['sports'],
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
