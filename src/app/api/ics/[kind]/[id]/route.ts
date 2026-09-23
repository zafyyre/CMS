import type { NextRequest } from 'next/server';
import {
  competitionCalendar,
  type FeedRequest,
  groupCalendar,
  teamCalendar,
  venueCalendar,
} from '@/server/services/calendar';
import { resolveLeagueByHostname } from '@/server/tenancy/current-league';

/**
 * Calendar subscription endpoints.
 *
 *   /api/ics/team/<id>.ics
 *   /api/ics/competition/<id>.ics
 *   /api/ics/venue/<id>.ics
 *   /api/ics/group/<id>.ics
 *
 * Public and unauthenticated, deliberately: a calendar client subscribes with
 * no credentials and no cookie, and anything requiring a session simply will
 * not work in Google Calendar or Apple Calendar. The data is the fixture list,
 * which is published on the site anyway — but it does mean the id in the URL is
 * the only thing selecting the resource, so nothing here may return anything a
 * signed-out visitor could not already see.
 *
 * The league still comes from the HOSTNAME, never from the URL, so the request
 * is scoped by the same mechanism as every page.
 */

export const dynamic = 'force-dynamic';

const KINDS = new Set(['team', 'competition', 'venue', 'group']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id: rawId } = await context.params;

  if (!KINDS.has(kind)) {
    return new Response('Unknown calendar type.', { status: 404 });
  }

  // The route is written with a `.ics` suffix so calendar clients recognise it
  // from the URL alone — several sniff the extension before the content type.
  const id = rawId.replace(/\.ics$/i, '');
  if (!UUID_RE.test(id)) {
    return new Response('Not a valid identifier.', { status: 400 });
  }

  const league = await resolveLeagueByHostname(request.headers.get('host') ?? '');
  if (!league) return new Response('No league at this address.', { status: 404 });

  const origin = new URL(request.url).origin;
  const feedRequest: FeedRequest = {
    orgId: league.id,
    origin,
    leagueName: league.name,
    timeZone: league.timezone,
  };

  const feed =
    kind === 'team'
      ? await teamCalendar(feedRequest, id)
      : kind === 'competition'
        ? await competitionCalendar(feedRequest, id)
        : kind === 'venue'
          ? await venueCalendar(feedRequest, id)
          : await groupCalendar(feedRequest, id);

  if (!feed) return new Response('Nothing to subscribe to at that address.', { status: 404 });

  return new Response(feed.body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      // Named so a subscriber sees something meaningful if their client
      // downloads the file rather than subscribing to it.
      'content-disposition': `inline; filename="${asciiFilename(feed.name)}.ics"`,
      // Match days move fixtures. An hour is short enough that a change lands
      // before kickoff and long enough not to be hammered by six thousand
      // clients polling.
      'cache-control': 'public, max-age=3600, stale-while-revalidate=600',
    },
  });
}

/**
 * `Content-Disposition` filenames are byte strings; a Croatian club name in a
 * plain `filename=` breaks parsing in some clients. Strip to ASCII rather than
 * reaching for the RFC 5987 form, which is not universally supported either.
 */
function asciiFilename(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'fixtures'
  );
}
