import Link from 'next/link';
import { ActionForm, Field, inputClass } from '@/components/admin/action-form';
import { StatusPill } from '@/components/status-pill';
import { listBatches } from '@/server/services/import';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import { stageImportAction } from '../actions';

/**
 * Historical import.
 *
 * The three steps are visible as three steps on purpose. An import that
 * presents itself as one button is an import whose operator does not know
 * whether their file was accepted, what it matched, or what it is about to
 * create — and they will find out by pressing it again.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Import' };

export default async function AdminImportPage() {
  const league = await getCurrentLeague();
  if (!league) return null;

  const batches = await listBatches(league.id);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Historical import</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Twelve seasons of records are not a parsing problem — they are a naming problem. Across
        that span teams rename, clubs merge, and the same club appears under three spellings.
        Nothing here is merged without somebody saying so.
      </p>

      <section className="mt-8 rounded-lg border p-5">
        <h2 className="text-lg font-medium">Stage a file</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A JSON export in the documented format. Staging writes nothing real: rows are parked,
          matched against what already exists, and anything ambiguous is queued for you.
        </p>

        <ActionForm action={stageImportAction} submitLabel="Stage and resolve" pendingLabel="Reading…">
          <Field label="Export file" name="export">
            <input
              id="export"
              name="export"
              type="file"
              accept=".json,application/json"
              required
              className={inputClass}
            />
          </Field>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="dryRun" defaultChecked />
            <span>Dry run — resolve everything but never allow promotion</span>
          </label>
        </ActionForm>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Batches</h2>
        {batches.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing has been staged yet.</p>
        ) : (
          <ul className="mt-3 divide-y rounded-lg border">
            {batches.map((batch) => (
              <li key={batch.batchId} className="flex flex-wrap items-baseline gap-3 px-4 py-3 text-sm">
                <Link href={`/admin/import/${batch.batchId}`} className="font-medium hover:underline">
                  {batch.source}
                </Link>
                <span className="tabular-nums text-muted-foreground">
                  {batch.recordsTotal} records
                </span>
                {batch.dryRun ? <StatusPill tone="info">Dry run</StatusPill> : null}
                {batch.recordsNeedingReview > 0 ? (
                  <StatusPill tone="caution">
                    {batch.recordsNeedingReview} awaiting a decision
                  </StatusPill>
                ) : batch.status === 'PROMOTED' ? (
                  <StatusPill tone="positive">Promoted</StatusPill>
                ) : (
                  <StatusPill tone="info">{batch.status.toLowerCase()}</StatusPill>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
