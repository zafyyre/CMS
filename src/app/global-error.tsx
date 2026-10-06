'use client'; // Error boundaries must be Client Components

import { buttonClass } from '@/components/ui/button';
import { cardClass } from '@/components/ui/card';
import './globals.css';
import styles from './status-pages.module.css';

/**
 * What shows when the ROOT LAYOUT itself fails — most often because the
 * database is unreachable, since the layout resolves the league before
 * anything renders. `error.tsx` cannot catch that: it sits inside the layout.
 *
 * It replaces the whole document, so it brings its own <html>, <body> and
 * stylesheet, and it has no header or footer because producing those is
 * exactly what failed. Without it the visitor got Next's unstyled default.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <title>Something went wrong</title>
        <main id="main" className={styles.standalone}>
          <div className={cardClass({ className: styles.errorCard })}>
            <h1 className={styles.errorTitle}>
              {/* Decoration: see error.tsx. */}
              <span aria-hidden="true">⚽</span> Something went wrong
            </h1>
            <p className={styles.errorText}>
              The site couldn’t load just now. Nothing is broken permanently — trying again
              almost always clears it.
            </p>
            {error.digest ? <pre className={styles.errorDetail}>Reference: {error.digest}</pre> : null}
            <div className={styles.choices}>
              <button type="button" className={buttonClass({ variant: 'primary' })} onClick={() => retry()}>
                Try again
              </button>
              {/* A plain anchor: client-side navigation needs the router that
                  the failed layout would have set up. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" className={buttonClass()}>
                Go home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
