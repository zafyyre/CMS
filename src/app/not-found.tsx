import Link from 'next/link';
import { PageFrame } from '@/components/site/page-frame';
import { buttonClass } from '@/components/ui/button';
import { cardClass } from '@/components/ui/card';
import styles from './status-pages.module.css';

export const metadata = {
  title: 'Page not found',
};

/**
 * Every unmatched URL and every `notFound()` lands here, inside the site's own
 * header and footer — until this existed, Next's built-in page showed with no
 * league chrome at all.
 */
export default function NotFound() {
  return (
    <PageFrame>
      <div className={cardClass({ className: styles.notFound })}>
        <div className={styles.mark} aria-hidden="true">
          ⚽
        </div>
        <h1 className={styles.notFoundTitle}>Page not found</h1>
        <p className={styles.notFoundText}>
          That page went out of bounds. Let’s get you back in play.
        </p>
        <Link href="/" className={buttonClass({ variant: 'primary' })}>
          Back to Home
        </Link>
      </div>
    </PageFrame>
  );
}
