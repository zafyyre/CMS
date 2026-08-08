import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/safe-next';

describe('safeNext', () => {
  it('preserves same-origin paths, queries, and fragments', () => {
    expect(safeNext('/admin/fixtures?season=2026#today')).toBe('/admin/fixtures?season=2026#today');
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/\u0000evil.example',
    'javascript:alert(1)',
  ])('falls back for an external or unsafe destination: %s', (next) => {
    expect(safeNext(next)).toBe('/admin');
  });
});
