/**
 * Per-league theming.
 *
 * This is a multi-tenant product: each league gets its own website and will
 * want its own colours. Rather than forking components per tenant, a league
 * seeds only the two variables its accent is derived from, and the whole
 * semantic layer in globals.css recomputes around them.
 *
 * Crucially, only HUE and CHROMA are tenant-controlled — never LIGHTNESS. The
 * semantic tokens fix lightness at values chosen to hold their contrast ratios,
 * so a league cannot pick a brand colour that quietly breaks the accessibility
 * guarantee for its own members. Chroma is clamped for the same reason.
 */

export interface LeagueTheme {
  /** 0–360. Anything else is ignored in favour of the default. */
  accentHue?: number;
  /** 0–0.2. Clamped, because an extreme value distorts the contrast maths. */
  accentChroma?: number;
}

const DEFAULT_HUE = 155;
const DEFAULT_CHROMA = 0.11;
const MAX_CHROMA = 0.2;

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

  return {
    '--accent-hue': String(hue),
    '--accent-chroma': String(chroma),
  } as React.CSSProperties;
}
