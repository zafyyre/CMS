/**
 * A CSV reader, written rather than installed.
 *
 * The league will hand over a season's schedule as a spreadsheet export, and
 * that file will contain the things spreadsheet exports contain: a UTF-8 BOM
 * from Excel, CRLF line endings, club names with commas in them
 * ("Kelowna United, Reserves"), and quoted fields containing quotes. A
 * `split(',')` handles none of those and fails in a way that looks like the
 * data is wrong.
 *
 * This follows RFC 4180 with the one universally-expected relaxation: a
 * newline inside quotes is part of the field, not a row break.
 */

export interface CsvRow {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  values: string[];
}

export function parseCsv(input: string): CsvRow[] {
  // Excel writes a BOM. Left in place it becomes part of the first header
  // name, so `header[0] === 'competition'` is false for reasons nobody can see.
  const text = input.replace(/^﻿/, '');

  const rows: CsvRow[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let sawAnyChar = false;

  const endField = () => {
    values.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A trailing newline should not produce a final empty row.
    if (!(values.length === 1 && values[0] === '')) {
      rows.push({ line: rowStartLine, values });
    }
    values = [];
    rowStartLine = line;
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (char === ',') {
      endField();
      sawAnyChar = true;
    } else if (char === '\r') {
      // Swallow; the \n that follows ends the row.
    } else if (char === '\n') {
      line++;
      endRow();
    } else {
      field += char;
      sawAnyChar = true;
    }
  }

  if (sawAnyChar || field !== '' || values.length > 0) endRow();
  return rows;
}

export interface CsvTable {
  /** Lower-cased, trimmed header names in file order. */
  headers: string[];
  rows: { line: number; get: (column: string) => string; raw: string[] }[];
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvFormatError';
  }
}

/**
 * Parse with a header row, addressing cells by column name.
 *
 * Column order is deliberately not significant. Whoever exports the schedule
 * will reorder the columns eventually, and a positional reader turns that into
 * a season of fixtures with the venue in the date field.
 */
export function parseCsvTable(input: string, required: readonly string[] = []): CsvTable {
  const rows = parseCsv(input);
  const [headerRow, ...dataRows] = rows;
  if (!headerRow) throw new CsvFormatError('The file is empty.');

  const headers = headerRow.values.map((h) => h.trim().toLowerCase());
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length > 0) {
    throw new CsvFormatError(
      `Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ` +
        `Found: ${headers.join(', ')}.`,
    );
  }

  const duplicate = headers.find((h, i) => headers.indexOf(h) !== i);
  if (duplicate) {
    throw new CsvFormatError(`The column "${duplicate}" appears more than once.`);
  }

  return {
    headers,
    rows: dataRows
      // A blank line in the middle of a spreadsheet export is noise, not a row.
      .filter((row) => row.values.some((v) => v.trim() !== ''))
      .map((row) => ({
        line: row.line,
        raw: row.values,
        get: (column: string) => {
          const index = headers.indexOf(column.toLowerCase());
          return index === -1 ? '' : (row.values[index] ?? '').trim();
        },
      })),
  };
}
