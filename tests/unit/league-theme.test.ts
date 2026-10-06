import { describe, expect, it } from 'vitest';
import { BRAND_DEFAULTS, leagueBrandColor, leagueThemeStyle } from '@/components/league-theme';

const style = (theme: unknown) => leagueThemeStyle(theme) as Record<string, string>;

describe('leagueThemeStyle', () => {
  it('seeds only the focus-ring inputs for a league that sets nothing', () => {
    expect(style({})).toEqual({ '--accent-hue': '155', '--accent-chroma': '0.11' });
    expect(style(null)).toEqual({ '--accent-hue': '155', '--accent-chroma': '0.11' });
  });

  it('applies a league’s brand colour overrides, lower-cased', () => {
    const s = style({ colors: { 'brand-800': '#1A2B3C', highlight: '#ffcc00' } });
    expect(s['--brand-800']).toBe('#1a2b3c');
    expect(s['--highlight']).toBe('#ffcc00');
    expect(s['--brand-700']).toBeUndefined();
  });

  it('ignores keys outside the brand allowlist, so no other custom property can be set', () => {
    const s = style({ colors: { background: '#000000', 'accent-hue': '#123456', '--brand-800': '#123456' } });
    expect(Object.keys(s).sort()).toEqual(['--accent-chroma', '--accent-hue']);
  });

  // The values land in an inline style attribute and come from the database.
  // Anything but six hex digits could smuggle in declarations of its own.
  it.each([
    'red',
    '#fff',
    '#12345',
    '#1234567',
    '#12345g',
    '#123456;background:url(https://evil.example/x)',
    'url(https://evil.example/x)',
    'var(--foreground)',
    ' #123456',
    '',
  ])('rejects a colour that is not exactly #rrggbb: %j', (value) => {
    expect(style({ colors: { 'brand-800': value } })['--brand-800']).toBeUndefined();
  });

  it('ignores a malformed colors field instead of throwing', () => {
    expect(() => style({ colors: 'green' })).not.toThrow();
    expect(() => style({ colors: ['#123456'] })).not.toThrow();
    expect(style({ colors: 42 })['--brand-800']).toBeUndefined();
  });
});

describe('leagueBrandColor', () => {
  it('falls back to the reference design’s value', () => {
    expect(leagueBrandColor({}, 'brand-800')).toBe(BRAND_DEFAULTS['brand-800']);
    expect(leagueBrandColor(undefined, 'brand-800')).toBe('#0b3d2e');
  });

  it('returns a league’s valid override, and ignores an invalid one', () => {
    expect(leagueBrandColor({ colors: { 'brand-800': '#1A2B3C' } }, 'brand-800')).toBe('#1a2b3c');
    expect(leagueBrandColor({ colors: { 'brand-800': 'red' } }, 'brand-800')).toBe('#0b3d2e');
  });
});

describe('BRAND_DEFAULTS', () => {
  // Duplicated from globals.css because the browser toolbar and the PWA
  // manifest need the colours outside CSS. This fails the moment they drift.
  it('matches the brand tokens declared in globals.css', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/app/globals.css', 'utf8');
    for (const [token, value] of Object.entries(BRAND_DEFAULTS)) {
      const declared = css.match(new RegExp(`--${token}:[ \t]*(#[0-9a-fA-F]{6});`))?.[1];
      expect(declared?.toLowerCase(), `--${token}`).toBe(value);
    }
  });
});
