'use client';

import { useActionState } from 'react';
import type { ActionResult } from '@/app/admin/actions';

/**
 * A form wired to a Server Action, with the result shown where it happened.
 *
 * The pattern this exists to enforce: an administrator who presses "Record
 * result" must see either what changed or why it did not, next to the button
 * they pressed. A silent success is indistinguishable from a silent failure,
 * and on a Sunday evening with forty results to enter, "did that save?" is a
 * question that gets answered by pressing the button again.
 *
 * `useActionState` also gives the pending flag for free, which is what stops
 * the double-submit that question produces.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  children,
  className,
  destructive,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  submitLabel: string;
  pendingLabel?: string;
  children?: React.ReactNode;
  className?: string;
  destructive?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => action(formData),
    null,
  );

  return (
    <form action={formAction} className={className}>
      {children}

      <button
        type="submit"
        disabled={pending}
        className={
          destructive
            ? 'mt-3 rounded-lg border border-status-negative/60 px-3 py-2 text-sm disabled:opacity-60'
            : 'mt-3 rounded-lg border border-foreground bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-60'
        }
      >
        {pending ? (pendingLabel ?? 'Working…') : submitLabel}
      </button>

      {state ? (
        <p
          // Announced, so the outcome reaches somebody using a screen reader
          // rather than only somebody watching the button.
          role="status"
          className={
            state.ok
              ? 'mt-3 whitespace-pre-line rounded-lg border border-status-positive/40 bg-status-positive-bg/40 px-3 py-2 text-sm'
              : 'mt-3 whitespace-pre-line rounded-lg border border-status-negative/40 bg-status-negative-bg/40 px-3 py-2 text-sm'
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/** A labelled field, so every input on these screens is actually associated. */
export function Field({
  label,
  name,
  hint,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-1">{children}</div>
    </div>
  );
}

export const inputClass = 'w-full rounded-lg border px-3 py-2 text-sm';
