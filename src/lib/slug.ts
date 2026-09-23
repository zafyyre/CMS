/**
 * URL-safe identifiers derived from names.
 *
 * The decomposition step matters more here than it usually does. Club and
 * person names in this league are Croatian, Punjabi, Italian, Portuguese and
 * Vietnamese; stripping non-ASCII without decomposing first turns "Krešimir"
 * into "kreimir" rather than "kresimir", which is both wrong and unsearchable.
 * NFKD splits the accent off the letter so the letter survives.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A slug that does not collide with one already taken.
 *
 * Appends `-2`, `-3` and so on. Two pitches at the same complex are genuinely
 * often called the same thing, and refusing the second one is not useful
 * behaviour for someone entering a hundred and forty venues.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const existing = new Set(taken);
  const root = slugify(base) || 'item';
  if (!existing.has(root)) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Could not derive a free slug from ${JSON.stringify(base)}`);
}
