/**
 * Per-league theming — the inputs a league controls.
 *
 * This is a multi-tenant product: each league gets its own website and will
 * want its own colours. A league's `organizations.theme` is read here and the
 * root layout applies the result to `<html>` — on `<html>` specifically,
 * because a custom property that feeds another is substituted where the
 * dependent one is DECLARED, and the dependants are declared on `:root`.
 *
 * Two kinds of input:
 *
 *  - `colors` — a league's own brand colours, overriding the reference
 *    design's defaults token by token. Only the tokens in BRAND_TOKENS can be
 *    set. A league that sets nothing renders exactly like the reference.
 *    Because `--primary` and the header and footer are built on these tokens,
 *    overriding them re-colours the whole shell.
 *
 *  - `accentHue` / `accentChroma` — tint the keyboard focus ring. Hue and
 *    chroma only, never lightness, and chroma is clamped, so the ring stays
 *    visible against the page whatever a league chooses.
 *
 * Nothing here has an admin screen yet; the values are set in the database.
 */

export interface LeagueTheme {
  /** 0–360. Anything else is ignored in favour of the default. */
  accentHue?: number;
  /** 0–0.2. Clamped, because an extreme value distorts the contrast maths. */
  accentChroma?: number;
  /** Overrides for the brand tokens, as `#rrggbb`. Anything else is ignored. */
  colors?: Partial<Record<BrandToken, string>>;
}

/**
 * The only tokens a league may override. An allowlist rather than a pattern,
 * so a stored key can never name some other custom property.
 */
export const BRAND_TOKENS = [
  'brand-500',
  'brand-600',
  'brand-700',
  'brand-800',
  'brand-900',
  'highlight',
  'highlight-foreground',
] as const;
export type BrandToken = (typeof BRAND_TOKENS)[number];

/**
 * The reference design's values for the brand tokens, used wherever a colour
 * is needed outside CSS — the browser toolbar and the PWA manifest. They must
 * match globals.css.
 */
export const BRAND_DEFAULTS: Record<BrandToken, string> = {
  'brand-500': '#1a8a5a',
  'brand-600': '#14724a',
  'brand-700': '#0f5132',
  'brand-800': '#0b3d2e',
  'brand-900': '#08301f',
  highlight: '#c8f244',
  'highlight-foreground': '#14351a',
};

/**
 * Exactly six hex digits. The value is written into an inline `style`
 * attribute, and it comes from the database: anything looser — a named colour,
 * a `url()`, a `;` — would let a stored string add declarations of its own.
 */
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULT_HUE = 155;
const DEFAULT_CHROMA = 0.11;
const MAX_CHROMA = 0.2;

function brandOverrides(theme: LeagueTheme): Partial<Record<BrandToken, string>> {
  const colors = theme.colors;
  if (!colors || typeof colors !== 'object') return {};
  const out: Partial<Record<BrandToken, string>> = {};
  for (const token of BRAND_TOKENS) {
    const value = (colors as Record<string, unknown>)[token];
    if (typeof value === 'string' && HEX.test(value)) out[token] = value.toLowerCase();
  }
  return out;
}

/** A brand token's value for this league: its override, or the default. */
export function leagueBrandColor(theme: unknown, token: BrandToken): string {
  return brandOverrides((theme ?? {}) as LeagueTheme)[token] ?? BRAND_DEFAULTS[token];
}

export function leagueThemeStyle(theme: unknown): React.CSSProperties {
  const t = (theme ?? {}) as LeagueTheme;

  const hue =
    typeof t.accentHue === 'number' && Number.isFinite(t.accentHue) && t.accentHue >= 0 && t.accentHue <= 360
      ? t.accentHue
      : DEFAULT_HUE;

  const chroma =
    typeof t.accentChroma === 'number' && Number.isFinite(t.accentChroma) && t.accentChroma >= 0
      ? Math.min(t.accentChroma, MAX_CHROMA)
      : DEFAULT_CHROMA;

  const style: Record<string, string> = {
    '--accent-hue': String(hue),
    '--accent-chroma': String(chroma),
  };
  for (const [token, value] of Object.entries(brandOverrides(t))) {
    style[`--${token}`] = value;
  }
  return style as React.CSSProperties;
}
