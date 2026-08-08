import Link from 'next/link';
import { leagueThemeStyle } from '@/components/league-theme';
import { StatusPill } from '@/components/status-pill';
import { formatKickoff } from '@/lib/time';
import { listVenues, type VenueSummary } from '@/server/services/venues';
import { getCurrentLeague } from '@/server/tenancy/current-league';

/**
 * Field status — a first-class page rather than a buried one.
 *
 * Between October and March "is the pitch open" is the highest-value thing
 * this league publishes, and on the old site it is several clicks down a menu
 * with no indication from anywhere else that anything has changed. Here the
 * closures are the first thing on the page, and the schedule links back to it
 * whenever any ground is shut.
 *
 * Surface, floodlights and municipality are shown because they are the three
 * things people actually ask: can we play there in the dark, is it grass, and
 * how far is it.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Fields' };

const SURFACE_LABEL: Record<VenueSummary['surface'], string> = {
  GRASS: 'Grass',
  ARTIFICIAL_TURF: 'Turf',
  INDOOR: 'Indoor',
  UNKNOWN: 'Not recorded',
};

export default async function FieldsPage() {
  const league = await getCurrentLeague();
  if (!league) {
    return (
      <main id="main" className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">No league configured</h1>
      </main>
    );
  }

  const venues = await listVenues(league.id);
  const closed = venues.filter((venue) => venue.closure !== null);
  const byMunicipality = groupByMunicipality(venues);

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10" style={leagueThemeStyle(league.theme)}>
      <header className="border-b pb-6">
        <Link
          href="/"
          className="text-xs font-medium uppercase tracking-widest text-muted-foreground hover:underline"
        >
          {league.shortName ?? league.slug}
        </Link>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Fields</h1>
        <div className="mt-3">
          {closed.length === 0 ? (
            <StatusPill tone="positive">All grounds open</StatusPill>
          ) : (
            <StatusPill tone="caution">
              {closed.length === 1 ? '1 ground closed' : `${closed.length} grounds closed`}
            </StatusPill>
          )}
        </div>
      </header>

      {closed.length > 0 ? (
        <section className="mt-8 rounded-lg border border-status-caution/40 bg-status-caution-bg/40 p-4">
          <h2 className="text-lg font-medium">Closed now</h2>
          <ul className="mt-3 space-y-3 text-sm">
            {closed.map((venue) => (
              <li key={venue.id}>
                <div className="font-medium">{venue.name}</div>
                <div className="text-muted-foreground">{venue.closure?.reason}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Since {formatKickoff(venue.closure!.startsAt, league.timezone)}
                  {venue.closure?.endsAt
                    ? ` · expected to reopen ${formatKickoff(venue.closure.endsAt, league.timezone)}`
                    : ' · until further notice'}
                  {venue.closure?.source ? ` · ${venue.closure.source}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {byMunicipality.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">No venues have been recorded yet.</p>
      ) : (
        byMunicipality.map(({ name, venues: local }) => (
          <section key={name} className="mt-10">
            <h2 className="text-lg font-medium">{name}</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Grounds in {name}</caption>
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">Ground</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Surface</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Floodlit</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {local.map((venue) => (
                    <tr key={venue.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">
                        {/* The complex is shown above the pitch rather than
                            glued into its name, which is how the old site
                            ends up with a hundred and forty unrelated
                            strings. */}
                        {venue.parentVenueName ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {venue.parentVenueName}
                          </span>
                        ) : null}
                        {stripComplexPrefix(venue)}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {SURFACE_LABEL[venue.surface]}
                      </td>
                      {/* Text, not a coloured dot — see components/status-pill. */}
                      <td className="py-2 pr-4 text-muted-foreground">
                        {venue.isFloodlit ? 'Yes' : 'No'}
                      </td>
                      <td className="py-2 pr-4">
                        {venue.closure ? (
                          <StatusPill tone="negative">Closed</StatusPill>
                        ) : (
                          <StatusPill tone="positive">Open</StatusPill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </main>
  );
}

/** "Rutland Sports Complex - Field 2" reads as "Field 2" under its complex. */
function stripComplexPrefix(venue: VenueSummary): string {
  if (!venue.parentVenueName) return venue.name;
  const prefix = `${venue.parentVenueName} - `;
  return venue.name.startsWith(prefix) ? venue.name.slice(prefix.length) : venue.name;
}

function groupByMunicipality(
  venues: VenueSummary[],
): { name: string; venues: VenueSummary[] }[] {
  const grouped = new Map<string, VenueSummary[]>();
  for (const venue of venues) {
    const key = venue.municipalityName ?? 'Elsewhere';
    const bucket = grouped.get(key);
    if (bucket) bucket.push(venue);
    else grouped.set(key, [venue]);
  }
  // listVenues already orders by municipality sort order then name, so the
  // insertion order of the map is the order the league wants.
  return [...grouped.entries()].map(([name, list]) => ({ name, venues: list }));
}
