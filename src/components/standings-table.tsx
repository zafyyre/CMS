import Link from 'next/link';
import { FormGuide } from '@/components/status-pill';
import type { StandingsView } from '@/server/services/standings';

/**
 * A league table, built for the way it is actually read: on a phone, outdoors,
 * often by somebody over fifty, scanning down one column.
 *
 * The decisions that follow from that:
 *
 * - **Tabular numerals on every figure.** Proportional digits do not line up
 *   in a column, and scanning a column is the only thing anyone does here.
 * - **A real `<caption>` and scope attributes**, so a screen reader announces
 *   "Rutland Rovers, points 34" rather than reading forty numbers in a row.
 * - **The reasoning is on the row.** `basis` is rendered as the row's
 *   accessible description and shown outright on narrow screens where the
 *   played/won/drawn columns are hidden — because on a phone the only two
 *   numbers that fit are position and points, and "why is this team above us"
 *   is exactly the question those two numbers provoke.
 * - **Nothing is encoded by colour alone.** A points deduction shows as
 *   "34 (−3)", not as a red number.
 */
export function StandingsTable({ table }: { table: StandingsView }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">
          {table.stageGroupName} table, {table.rows.length} teams, updated{' '}
          {table.computedAt.toISOString()}
        </caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-2 pr-2 font-medium">
              <span className="sr-only">Position</span>
              <span aria-hidden="true">#</span>
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Team
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              <abbr title="Played">P</abbr>
            </th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">
              <abbr title="Won">W</abbr>
            </th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">
              <abbr title="Drawn">D</abbr>
            </th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">
              <abbr title="Lost">L</abbr>
            </th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium md:table-cell">
              <abbr title="Goals for">GF</abbr>
            </th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium md:table-cell">
              <abbr title="Goals against">GA</abbr>
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              <abbr title="Goal difference">GD</abbr>
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              <abbr title="Points">Pts</abbr>
            </th>
            <th scope="col" className="hidden py-2 text-right font-medium lg:table-cell">
              Form
            </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.entryId} className="border-b last:border-0">
              <td className="py-2 pr-2 tabular-nums text-muted-foreground">{row.position}</td>
              <th scope="row" className="py-2 pr-4 text-left font-medium">
                <Link href={`/teams/${row.teamSlug}`} className="hover:underline">
                  {row.teamName}
                </Link>
                {/* The reasoning, always available to assistive technology and
                    shown outright where the detail columns are hidden. */}
                <span className="block text-xs font-normal text-muted-foreground sm:hidden">
                  {row.basis}
                </span>
                {row.requiresManualResolution ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    Position provisional pending a drawing of lots.
                  </span>
                ) : null}
              </th>
              <td className="py-2 pr-3 text-right tabular-nums">{row.played}</td>
              <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">{row.won}</td>
              <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">
                {row.drawn}
              </td>
              <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">{row.lost}</td>
              <td className="hidden py-2 pr-3 text-right tabular-nums md:table-cell">
                {row.goalsFor}
              </td>
              <td className="hidden py-2 pr-3 text-right tabular-nums md:table-cell">
                {row.goalsAgainst}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
              </td>
              <td className="py-2 pr-3 text-right font-semibold tabular-nums">
                {row.points}
                {row.pointsAdjustment !== 0 ? (
                  // Shown, not hidden: "31" with no explanation is what
                  // generates a fortnight of email.
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({row.pointsAdjustment > 0 ? '+' : '−'}
                    {Math.abs(row.pointsAdjustment)})
                  </span>
                ) : null}
              </td>
              <td className="hidden py-2 text-right lg:table-cell">
                {row.form.length > 0 ? <FormGuide results={row.form} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* The full reasoning for every row, for wider screens and for anyone
          who wants the detail without hovering. */}
      <details className="mt-3 hidden sm:block">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Why each team is placed where it is
        </summary>
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {table.rows.map((row) => (
            <li key={row.entryId}>
              <span className="font-medium text-foreground">{row.teamName}</span> — {row.basis}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
