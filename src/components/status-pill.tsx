import { AlertTriangle, CalendarClock, CheckCircle2, CircleSlash } from 'lucide-react';
import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

/**
 * A status indicator that never relies on colour alone.
 *
 * Roughly 8% of men have red/green colour deficiency. This league is about
 * 6,000 men, so that is ~480 people for whom a red dot and a green dot are the
 * same dot. Every status therefore carries three channels, in this order of
 * importance:
 *
 *   1. TEXT   — the word itself, always present and never abbreviated to a code
 *   2. SHAPE  — a distinct glyph per tone, distinguishable without colour
 *   3. COLOUR — the last and least important channel
 *
 * Remove the colour entirely and this component still communicates. That is the
 * test it is designed to pass, and the reason it exists as a component rather
 * than as a `<span className="text-red-500">` scattered through the codebase.
 */

export type StatusTone = 'positive' | 'caution' | 'negative' | 'info';

const TONES: Record<
  StatusTone,
  { icon: ComponentType<{ className?: string }>; className: string; srPrefix: string }
> = {
  positive: {
    icon: CheckCircle2,
    className: 'bg-status-positive-bg text-status-positive',
    srPrefix: 'Confirmed:',
  },
  caution: {
    icon: AlertTriangle,
    className: 'bg-status-caution-bg text-status-caution',
    srPrefix: 'Needs attention:',
  },
  negative: {
    icon: CircleSlash,
    className: 'bg-status-negative-bg text-status-negative',
    srPrefix: 'Blocked:',
  },
  info: {
    icon: CalendarClock,
    className: 'bg-status-info-bg text-status-info',
    srPrefix: 'Scheduled:',
  },
};

export interface StatusPillProps {
  tone: StatusTone;
  /**
   * Written in plain English, for a reader who does not know the system.
   * "Suspended until 12 October", not "SUSP-3-SERVED-1".
   */
  children: React.ReactNode;
  className?: string;
}

export function StatusPill({ tone, children, className }: StatusPillProps) {
  const { icon: Icon, className: toneClass, srPrefix } = TONES[tone];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5',
        'text-sm font-medium whitespace-nowrap',
        toneClass,
        className,
      )}
    >
      {/* Announced to screen readers so the tone is not conveyed visually only. */}
      <span className="sr-only">{srPrefix}</span>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * A form guide — the WWDLW strip beside a team in a table.
 *
 * Letters first, colour second, for the same reason as above. A colour-blind
 * reader loses nothing.
 */
export function FormGuide({ results }: { results: ReadonlyArray<'W' | 'D' | 'L'> }) {
  const tone = { W: 'positive', D: 'info', L: 'negative' } as const;

  return (
    <span className="inline-flex gap-1" aria-label={`Recent form: ${results.join(', ')}`}>
      {results.map((r, i) => (
        <span
          key={`${r}-${i}`}
          aria-hidden="true"
          className={cn(
            'inline-flex size-5 items-center justify-center rounded text-xs font-semibold',
            TONES[tone[r]].className,
          )}
        >
          {r}
        </span>
      ))}
    </span>
  );
}
