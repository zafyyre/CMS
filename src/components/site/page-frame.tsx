import styles from './page-frame.module.css';

/**
 * A page's `<main>` inside the site's width and gutters — the one container
 * every page uses, so page content lines up with the header and footer.
 * Carries `id="main"`, which the skip link in the root layout targets.
 *
 * `measure` caps the content's width for pages that are a form, a short
 * notice or a block of prose, which would otherwise stretch to unreadable line
 * lengths. Content stays left-aligned within the frame, as the reference
 * design has it, rather than being centred in a narrower column of its own.
 */
export function PageFrame({
  children,
  measure,
}: {
  children: React.ReactNode;
  measure?: 'form' | 'narrow' | 'prose';
}) {
  return (
    <main id="main" className={styles.main}>
      <div className={styles.frame}>
        {measure ? <div className={styles[measure]}>{children}</div> : children}
      </div>
    </main>
  );
}
