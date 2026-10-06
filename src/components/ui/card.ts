import styles from './card.module.css';

/** The class list for a card; `padded` adds the standard inner spacing. */
export function cardClass({ padded = false, className }: { padded?: boolean; className?: string } = {}) {
  return [styles.root, padded ? styles.padded : null, className].filter(Boolean).join(' ');
}
