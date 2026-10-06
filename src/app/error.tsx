'use client'; // Error boundaries must be Client Components

import Link from 'next/link';
import { PageFrame } from '@/components/site/page-frame';
import { buttonClass } from '@/components/ui/button';
import { cardClass } from '@/components/ui/card';
import styles from './status-pages.module.css';

/**
 * What a page shows when rendering it throws — inside the site's header and
 * footer, which still work, so the visitor is never stranded.
 *
 * In production a server error's message is replaced with a generic one, so
 * the useful thing to show is the `digest`: it is the key that finds the full
 * error in the server logs, and it reveals nothing about the failure itself.
 *
 * `retry` re-fetches and re-renders the segment, which is what clears the
 * usual cause here — a database or network hiccup on the way in.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <PageFrame>
      <div className={styles.errorFrame}>
        <div className={cardClass({ className: styles.errorCard })}>
          <h1 className={styles.errorTitle}>
            {/* The ball is decoration: hidden, a screen reader announced the
                heading as "soccer ball, Something went wrong". */}
            <span aria-hidden="true">⚽</span> Something went wrong
          </h1>
          <p className={styles.errorText}>
            This page hit an unexpected error. Nothing is broken permanently — trying again almost
            always clears it.
          </p>
          {error.digest ? <pre className={styles.errorDetail}>Reference: {error.digest}</pre> : null}
          <div className={styles.choices}>
            <button type="button" className={buttonClass({ variant: 'primary' })} onClick={() => retry()}>
              Try again
            </button>
            <Link href="/" className={buttonClass()}>
              Go home
            </Link>
          </div>
        </div>
      </div>
    </PageFrame>
  );
}
