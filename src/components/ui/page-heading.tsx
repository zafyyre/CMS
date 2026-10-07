import styles from './page-heading.module.css';

/**
 * A page's title block: its one `<h1>`, an optional overline above it and an
 * optional description below.
 *
 * The title is always the page's `<h1>`. The reference design styles an
 * `<h2>` here, because its site header holds the `<h1>`; this project's header
 * does not, so the page keeps the `<h1>` and the styles make it render the same.
 *
 * The description is rendered inside a `<p>`, so it takes phrasing content
 * only — text, links, a status pill.
 */
export function PageHeading({
  title,
  overline,
  description,
}: {
  title: React.ReactNode;
  overline?: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className={styles.root}>
      {overline ? <span className={styles.overline}>{overline}</span> : null}
      <h1 className={styles.title}>{title}</h1>
      {description ? <p className={styles.description}>{description}</p> : null}
    </div>
  );
}
