import { ActionForm, Field, inputClass } from '@/components/admin/action-form';
import { StatusPill } from '@/components/status-pill';
import { formatKickoff } from '@/lib/time';
import { listClosuresInForce, listVenues } from '@/server/services/venues';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import { closeVenueAction, createVenueAction, reopenVenueAction } from '../actions';

/**
 * Venues and, more importantly, closures.
 *
 * Between October and March the closure form is the most-used control in this
 * whole admin area: somebody from the city rings at eight on a Saturday
 * morning, and the league has ninety minutes to tell four hundred people not
 * to drive to a shut pitch. Everything about this screen is shaped by that
 * ninety minutes — the form is above the list, the reason is the only required
 * field, and closing a ground publishes to the front page immediately.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Venues' };

const SURFACES = ['GRASS', 'ARTIFICIAL_TURF', 'INDOOR', 'UNKNOWN'] as const;

export default async function AdminVenuesPage() {
  const league = await getCurrentLeague();
  if (!league) return null;

  const [venues, closures] = await Promise.all([
    listVenues(league.id),
    listClosuresInForce(league.id),
  ]);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Venues</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {venues.length} grounds · {closures.length} closed right now
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section className="rounded-lg border p-5">
          <h2 className="text-lg font-medium">Close a ground</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Appears on the front page, the schedule and the field-status page straight away.
            Leave the end date empty for &ldquo;until further notice&rdquo;.
          </p>

          <ActionForm action={closeVenueAction} submitLabel="Close it">
            <Field label="Ground" name="venueId">
              <select id="venueId" name="venueId" required className={inputClass}>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason (required)" name="reason" hint="Shown publicly, in plain English.">
              <input
                id="reason"
                name="reason"
                type="text"
                required
                placeholder="Standing water — unplayable"
                className={inputClass}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From" name="startsAt" hint="Now, if left empty.">
                <input id="startsAt" name="startsAt" type="datetime-local" className={inputClass} />
              </Field>
              <Field label="Until" name="endsAt" hint="Empty means indefinitely.">
                <input id="endsAt" name="endsAt" type="datetime-local" className={inputClass} />
              </Field>
            </div>
            <Field label="Who says so" name="source">
              <input id="source" name="source" type="text" placeholder="City parks department" className={inputClass} />
            </Field>
          </ActionForm>
        </section>

        <section className="rounded-lg border p-5">
          <h2 className="text-lg font-medium">Add a ground</h2>
          <ActionForm action={createVenueAction} submitLabel="Add">
            <Field label="Name" name="name">
              <input id="name" name="name" type="text" required className={inputClass} />
            </Field>
            <Field label="Surface" name="surface">
              <select id="surface" name="surface" className={inputClass}>
                {SURFACES.map((surface) => (
                  <option key={surface} value={surface}>
                    {surface.toLowerCase().replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" name="isFloodlit" />
              <span>Floodlit</span>
            </label>
            <Field label="Address" name="address">
              <input id="address" name="address" type="text" className={inputClass} />
            </Field>
          </ActionForm>
        </section>
      </div>

      {closures.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-medium">Closed now</h2>
          <ul className="mt-3 divide-y rounded-lg border">
            {closures.map((closure) => (
              <li key={closure.id} className="flex flex-wrap items-baseline gap-3 px-4 py-3 text-sm">
                <span className="font-medium">{closure.venueName}</span>
                <span className="text-muted-foreground">{closure.reason}</span>
                <span className="text-xs text-muted-foreground">
                  since {formatKickoff(closure.startsAt, league.timezone, { withZone: false })}
                </span>
                <div className="ml-auto">
                  <ActionForm action={reopenVenueAction} submitLabel="Reopen">
                    <input type="hidden" name="closureId" value={closure.id} />
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-medium">All grounds</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Every ground in the league</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">Ground</th>
                <th scope="col" className="py-2 pr-4 font-medium">Municipality</th>
                <th scope="col" className="py-2 pr-4 font-medium">Surface</th>
                <th scope="col" className="py-2 pr-4 font-medium">Floodlit</th>
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {venues.map((venue) => (
                <tr key={venue.id} className="border-b last:border-0">
                  <th scope="row" className="py-2 pr-4 text-left font-medium">{venue.name}</th>
                  <td className="py-2 pr-4 text-muted-foreground">{venue.municipalityName ?? '—'}</td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {venue.surface.toLowerCase().replace(/_/g, ' ')}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">{venue.isFloodlit ? 'Yes' : 'No'}</td>
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
    </>
  );
}
