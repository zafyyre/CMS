/**
 * Per-league theming — the inputs a league controls.
 *
 * This is a multi-tenant product: each league gets its own website and will
 * want its own colours. A league seeds two variables from
 * `organizations.theme`, and the root layout applies them to `<html>`.
 *
 * What they reach TODAY is only `--ring`, the keyboard focus outline. Every
 * other colour in globals.css is a fixed value taken from the reference
 * design, so a league that sets nothing renders exactly like it. Letting a
 * league restyle its brand colours themselves is a later step, whose shape is
 * not yet designed — expect this interface to change when it lands.
 *
 * Only HUE and CHROMA are accepted, never lightness, and chroma is clamped, so
 * the focus ring stays visible against the page whatever a league chooses.
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
