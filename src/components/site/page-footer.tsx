import Link from 'next/link';
import { FOOTER_COLUMNS } from './sections';
import styles from './page-footer.module.css';

/**
 * The footer on every page: the league, what the site is for, and the same
 * sections the header offers, split into two columns.
 */
export function PageFooter({ leagueName }: { leagueName: string }) {
  return (
    <footer className={styles.footer}>
      <div className={styles.frame}>
        <div className={styles.columns}>
          <div>
            <h2 className={styles.heading}>{leagueName}</h2>
            <p className={styles.about}>
              Fixtures, results, standings and field status for {leagueName}.
            </p>
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className={styles.heading}>{column.heading}</h2>
              <ul className={styles.links}>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className={styles.legal}>
          © {new Date().getFullYear()} {leagueName}
        </div>
      </div>
    </footer>
  );
}
