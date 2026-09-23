import { describe, expect, it } from 'vitest';
import { serializeJsonLd } from '@/lib/json-ld';

/**
 * The escaping that keeps structured data from becoming script.
 *
 * Club and team names reach these blocks from the CSV and legacy-JSON
 * importers, so "a name containing markup" is reachable input rather than a
 * hypothetical.
 */

/**
 * Built with `String.fromCharCode` rather than pasted as literals.
 *
 * These two characters are line terminators to a JavaScript parser, so writing
 * them into a source file ends the line mid-expression — the same hazard the
 * escaping exists to prevent, and it broke `src/lib/json-ld.ts` once.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe('breaking out of the script tag', () => {
  it('escapes a closing script tag hidden in a name', () => {
    const output = serializeJsonLd({
      name: 'Rutland Rovers</script><script>alert(1)</script>',
    });

    // Nothing an HTML tokeniser will read as a tag boundary.
    expect(output).not.toContain('</script>');
    expect(output).not.toContain('<');
    expect(output).not.toContain('>');
    expect(output).toContain('\\u003c');
  });

  it('escapes ampersands, so an entity cannot be reinterpreted', () => {
    expect(serializeJsonLd({ name: 'Hope & Anchor' })).toContain('\\u0026');
  });

  it('escapes the two separators that are legal JSON but break JavaScript', () => {
    const output = serializeJsonLd({
      name: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`,
    });

    expect(output).toContain('\\u2028');
    expect(output).toContain('\\u2029');
    expect(output).not.toContain(LINE_SEPARATOR);
    expect(output).not.toContain(PARAGRAPH_SEPARATOR);
  });
});

describe('the data still means the same thing', () => {
  it('round-trips through a JSON parser unchanged', () => {
    // The escapes are JSON-level, so a consumer decodes exactly the original.
    const original = {
      '@type': 'SportsOrganization',
      name: 'Rutland Rovers</script>',
      note: 'Hope & Anchor <b>',
      founded: 1974,
      teams: ['First XI', 'Reserves'],
    };

    expect(JSON.parse(serializeJsonLd(original))).toEqual(original);
  });

  it('round-trips the line separators too', () => {
    const original = { name: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c` };
    expect(JSON.parse(serializeJsonLd(original))).toEqual(original);
  });

  it('leaves an ordinary name alone apart from the escapes', () => {
    expect(JSON.parse(serializeJsonLd({ name: 'Glenmore Athletic' }))).toEqual({
      name: 'Glenmore Athletic',
    });
  });

  it('handles accented names, which this league is full of', () => {
    const original = { name: 'Peñarol', keeper: 'Krešimir' };
    expect(JSON.parse(serializeJsonLd(original))).toEqual(original);
  });
});
