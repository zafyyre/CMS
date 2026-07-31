import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { cache } from 'react';
import { withSystem } from '@/db';
import { type OrgId, unsafeAsOrgId } from '@/db/org-id';
import { organizations, orgDomains } from '@/db/schema';
import { env } from '@/env';

/**
 * Which league does this request belong to?
 *
 * Each league has its own website, so the answer comes from the request's
 * hostname. This lookup necessarily happens BEFORE any league context exists,
 * which is why `organizations` and `org_domains` are read-open routing tables
 * (see src/db/policies.ts) and why these functions use `withSystem()`.
 */

export interface CurrentLeague {
  /** Branded — one of only two places an OrgId is minted. */
  id: OrgId;
  slug: string;
  name: string;
  shortName: string | null;
  timezone: string;
  /** Seeds the accent hue/chroma. See src/components/league-theme.tsx. */
  theme: unknown;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1', '']);

/**
 * Strips the port, lowercases, and drops a trailing FQDN dot.
 *
 * Duplicated from middleware deliberately. Middleware normalises the host into
 * `x-league-host`, but this must not DEPEND on middleware having run — a raw
 * `Host` header carries the port (`localhost:3000`), which matches neither the
 * local-host list nor any registered domain, and the request then resolves to
 * no league at all. Normalising in both places makes the resolver correct on
 * its own.
 */
export function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.split(':')[0]?.trim().toLowerCase().replace(/\.$/, '') ?? '';
}

const isLocalHost = (hostname: string) =>
  LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');

const SELECTION = {
  id: organizations.id,
  slug: organizations.slug,
  name: organizations.name,
  shortName: organizations.shortName,
  timezone: organizations.timezone,
  theme: organizations.theme,
};

function toLeague(row: {
  id: string;
  slug: string;
  name: string;
  shortName: string | null;
  timezone: string;
  theme: unknown;
}): CurrentLeague {
  return { ...row, id: unsafeAsOrgId(row.id, 'organizations.id') };
}

export async function resolveLeagueByHostname(hostname: string): Promise<CurrentLeague | null> {
  const host = normalizeHost(hostname);

  return withSystem('resolve league from request hostname', async (tx) => {
    if (!isLocalHost(host)) {
      const [exact] = await tx
        .select(SELECTION)
        .from(orgDomains)
        .innerJoin(organizations, eq(orgDomains.orgId, organizations.id))
        .where(eq(orgDomains.hostname, host))
        .limit(1);
      if (exact) return toLeague(exact);

      // A league that registered example.com should not 404 on www.example.com.
      // The reverse is NOT attempted: adding a "www." prefix could match a
      // different league's registered domain.
      if (host.startsWith('www.')) {
        const [stripped] = await tx
          .select(SELECTION)
          .from(orgDomains)
          .innerJoin(organizations, eq(orgDomains.orgId, organizations.id))
          .where(eq(orgDomains.hostname, host.slice(4)))
          .limit(1);
        if (stripped) return toLeague(stripped);
      }
      return null;
    }

    // localhost carries no tenant information, so fall back to the configured
    // default league for local development and preview deploys.
    const [fallback] = await tx
      .select(SELECTION)
      .from(organizations)
      .where(eq(organizations.slug, env.DEFAULT_ORG_SLUG))
      .limit(1);
    return fallback ? toLeague(fallback) : null;
  });
}

/**
 * The current request's league.
 *
 * Wrapped in React's `cache()` so a page rendering a dozen server components
 * resolves it once per request rather than a dozen times.
 */
export const getCurrentLeague = cache(async (): Promise<CurrentLeague | null> => {
  const headerList = await headers();

  /**
   * Reads `Host` ONLY — never `x-league-host`.
   *
   * An earlier version preferred `x-league-host`, which middleware sets after
   * normalising. That made a *request header* authoritative for tenant
   * selection, and middleware is not guaranteed to run: its matcher excludes
   * any path ending in an image extension, so `GET /clubs/anything.png` skips
   * sanitisation entirely and a client-supplied `x-league-host` would arrive
   * untouched. Since the resolved league seeds `app.current_org_id`, and every
   * RLS policy compares against that, a crafted header would have selected
   * which league's rows the database returned.
   *
   * It was not reachable — only `/` resolves a league today, and `/` does run
   * middleware — but the next route taking a slug would have made it live.
   *
   * The header is now simply unnecessary: `resolveLeagueByHostname` calls
   * `normalizeHost()` itself, which is the only thing middleware was adding.
   * Deleting the preference removes the trust boundary rather than narrowing
   * it, so no future routing change can reopen this.
   */
  return resolveLeagueByHostname(headerList.get('host') ?? '');
});
