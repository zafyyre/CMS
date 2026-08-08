import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, Field, inputClass } from '@/components/admin/action-form';
import { StatusPill } from '@/components/status-pill';
import { checkImportedStandings, getBatch, listReviewQueue } from '@/server/services/import';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import { confirmMatchAction, promoteImportAction, rejectMatchAction } from '../../actions';

/**
 * The entity-resolution review queue.
 *
 * This screen is the whole reason the importer is safe. Everything else in
 * Phase 5 is bookkeeping around one question asked repeatedly: is this the club
 * we already have, or a different one?
 *
 * Getting it wrong in the merging direction is unrecoverable — the evidence
 * that two clubs were ever separate is exactly what a bad merge destroys — so
 * the machine never answers it. It ranks candidates, pre-selects one when it is
 * very confident, and waits. Each decision is stored as a confirmed alias, so
 * the first season is laborious and the remaining eleven are not.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ batchId: string }>;
}

export const metadata = { title: 'Review' };

export default async function ImportReviewPage({ params }: PageProps) {
  const league = await getCurrentLeague();
  if (!league) notFound();

  const { batchId } = await params;
  const batch = await getBatch(league.id, batchId).catch(() => null);
  if (!batch) notFound();

  const [queue, checks] = await Promise.all([
    listReviewQueue(league.id, batchId),
    // Only meaningful once results are in the database.
    batch.status === 'PROMOTED'
      ? checkImportedStandings(league.id, batchId)
      : Promise.resolve([]),
  ]);

  return (
    <>
      <nav className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Link href="/admin/import" className="hover:underline">
          Import
        </Link>
      </nav>

      <header className="mt-1 border-b pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{batch.source}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="tabular-nums">{batch.recordsTotal} records</span>
          <span className="tabular-nums">{batch.recordsMatched} matched</span>
          <span className="tabular-nums">{batch.recordsNeedingReview} awaiting a decision</span>
          {batch.dryRun ? <StatusPill tone="info">Dry run</StatusPill> : null}
          {batch.status === 'PROMOTED' ? <StatusPill tone="positive">Promoted</StatusPill> : null}
        </div>
      </header>

      {queue.length === 0 ? (
        <section className="mt-8 rounded-lg border p-5">
          <h2 className="text-lg font-medium">Nothing left to decide</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {batch.status === 'PROMOTED'
              ? 'This batch has been written into the league. Promoting again is refused, and discarding it would not undo it.'
              : batch.dryRun
                ? 'This was staged as a dry run, so it cannot be promoted. Re-stage the file with the dry-run box cleared.'
                : 'Every row is resolved. Promotion will create what is new and leave what already existed alone.'}
          </p>

          {batch.status !== 'PROMOTED' && !batch.dryRun ? (
            <ActionForm action={promoteImportAction} submitLabel="Promote into the league">
              <input type="hidden" name="batchId" value={batchId} />
            </ActionForm>
          ) : null}
        </section>
      ) : (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Is this the same thing?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing can be promoted until every one of these is answered.
          </p>

          <ul className="mt-4 space-y-4">
            {queue.map((item) => (
              <li key={item.recordId} className="rounded-lg border p-5">
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {item.entityKind.toLowerCase()}
                  </span>
                  <span className="text-lg font-medium">{item.sourceName}</span>
                </div>
                {item.message ? (
                  <p className="mt-1 text-sm text-muted-foreground">{item.message}</p>
                ) : null}

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <ActionForm action={confirmMatchAction} submitLabel="Yes, it is this one">
                    <input type="hidden" name="batchId" value={batchId} />
                    <input type="hidden" name="recordId" value={item.recordId} />
                    <Field label="Existing record" name={`canonical-${item.recordId}`}>
                      <select
                        id={`canonical-${item.recordId}`}
                        name="canonicalId"
                        // Pre-selects the best candidate; it does not decide.
                        defaultValue={item.candidates[0]?.id ?? ''}
                        className={inputClass}
                      >
                        {item.candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name} — {Math.round(candidate.score * 100)}% alike
                          </option>
                        ))}
                      </select>
                    </Field>
                  </ActionForm>

                  <ActionForm action={rejectMatchAction} submitLabel="No, it is new" destructive>
                    <input type="hidden" name="batchId" value={batchId} />
                    <input type="hidden" name="recordId" value={item.recordId} />
                    <p className="text-sm text-muted-foreground">
                      A separate club or team that happens to have a similar name. It will be
                      created on promotion.
                    </p>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {checks.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-medium">Does our table match theirs?</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each imported season&rsquo;s table, recomputed from the results we imported and
            compared against the table the source published. One comparison checks the importer,
            the schema and the standings engine at once — where they disagree, exactly one of the
            three is wrong.
          </p>

          <ul className="mt-4 space-y-3">
            {checks.map((check, index) => (
              <li key={`${check.competitionKey}-${index}`} className="rounded-lg border p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{check.competitionKey}</span>
                  {check.groupKey ? (
                    <span className="text-sm text-muted-foreground">{check.groupKey}</span>
                  ) : null}
                  {!check.resolved ? (
                    <StatusPill tone="caution">Cannot compare</StatusPill>
                  ) : check.matches ? (
                    <StatusPill tone="positive">Matches exactly</StatusPill>
                  ) : (
                    <StatusPill tone="negative">
                      {check.summary.length} difference{check.summary.length === 1 ? '' : 's'}
                    </StatusPill>
                  )}
                </div>

                {check.hints.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-sm">
                    {check.hints.map((hint) => (
                      <li key={hint}>{hint}</li>
                    ))}
                  </ul>
                ) : null}

                {check.summary.length > 0 ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-muted-foreground">
                      Every difference
                    </summary>
                    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                      {check.summary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
