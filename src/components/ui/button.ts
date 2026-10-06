import styles from './button.module.css';

export type ButtonVariant = 'default' | 'primary' | 'highlight';
export type ButtonSize = 'default' | 'small';

/**
 * The class list for a button, for use on a <button> or a <Link> alike — a
 * link that looks like a button is still a link, so it stays an <a>.
 */
export function buttonClass({
  variant = 'default',
  size = 'default',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return [
    styles.button,
    variant === 'primary' ? styles.primary : null,
    variant === 'highlight' ? styles.highlight : null,
    size === 'small' ? styles.small : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
}
