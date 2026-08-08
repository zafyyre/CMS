import { describe, expect, it } from 'vitest';
import { CsvFormatError, parseCsv, parseCsvTable } from '@/lib/csv';

/**
 * The CSV reader, tested against what a spreadsheet export actually contains
 * rather than against what a well-formed CSV looks like. Every case below has
 * a specific real-world source: Excel's BOM, Windows line endings, club names
 * with commas, and a league that reorders its columns between uploads.
 */

describe('fields', () => {
  it('reads a plain file', () => {
    expect(parseCsv('a,b\n1,2').map((r) => r.values)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma that is inside quotes', () => {
    // "Kelowna United, Reserves" is one club, not two columns.
    const rows = parseCsv('home,away\n"Kelowna United, Reserves",Rutland');
    expect(rows[1]?.values).toEqual(['Kelowna United, Reserves', 'Rutland']);
  });

  it('unescapes a doubled quote', () => {
    expect(parseCsv('note\n"the ""old"" ground"')[1]?.values).toEqual(['the "old" ground']);
  });

  it('keeps a newline that is inside quotes', () => {
    const rows = parseCsv('note\n"line one\nline two"\nnext');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.values).toEqual(['line one\nline two']);
    expect(rows[2]?.values).toEqual(['next']);
  });

  it('handles Windows line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').map((r) => r.values)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips the byte-order mark Excel writes', () => {
    // Left in place it becomes part of the first header name, and every
    // lookup of that column silently returns nothing.
    const table = parseCsvTable('﻿competition,group\nPremier,Table');
    expect(table.headers[0]).toBe('competition');
    expect(table.rows[0]?.get('competition')).toBe('Premier');
  });

  it('preserves empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,')[1]?.values).toEqual(['1', '', '']);
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseCsv('a\n1\n')).toHaveLength(2);
  });

  it('reports the source line number for error messages', () => {
    const rows = parseCsv('h\n"two\nlines"\nthird');
    expect(rows.map((r) => r.line)).toEqual([1, 2, 4]);
  });
});

describe('tables', () => {
  const csv = 'Competition,Group,Home,Away\nPremier,Table,Rutland,Glenmore\n';

  it('addresses cells by column name, case-insensitively', () => {
    const table = parseCsvTable(csv);
    expect(table.rows[0]?.get('home')).toBe('Rutland');
    expect(table.rows[0]?.get('HOME')).toBe('Rutland');
  });

  it('does not care about column order', () => {
    // Whoever exports the schedule will reorder the columns eventually, and a
    // positional reader turns that into a season of fixtures with the venue in
    // the date field.
    const reordered = 'Away,Home,Group,Competition\nGlenmore,Rutland,Table,Premier\n';
    expect(parseCsvTable(reordered).rows[0]?.get('home')).toBe('Rutland');
  });

  it('names every missing required column at once', () => {
    let caught: unknown;
    try {
      parseCsvTable('competition,group\nPremier,Table', ['competition', 'group', 'home', 'away']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CsvFormatError);
    expect((caught as Error).message).toContain('home');
    expect((caught as Error).message).toContain('away');
  });

  it('rejects a duplicated column rather than silently picking one', () => {
    expect(() => parseCsvTable('home,home\na,b')).toThrow(CsvFormatError);
  });

  it('skips blank lines in the middle of a spreadsheet export', () => {
    const withBlank = 'home,away\nRutland,Glenmore\n\nPeachland,Ellison\n';
    expect(parseCsvTable(withBlank).rows).toHaveLength(2);
  });

  it('rejects an empty file with a message rather than returning nothing', () => {
    expect(() => parseCsvTable('')).toThrow(CsvFormatError);
  });

  it('returns an empty string for a column that is not present', () => {
    expect(parseCsvTable(csv).rows[0]?.get('venue')).toBe('');
  });

  it('trims surrounding whitespace from values', () => {
    const padded = 'home , away\n Rutland , Glenmore \n';
    expect(parseCsvTable(padded).rows[0]?.get('away')).toBe('Glenmore');
  });
});
