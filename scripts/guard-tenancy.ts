import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * A static guard against the ways league isolation gets bypassed by accident.
 *
 * RLS is the real enforcement and the integration suite proves it works. This
 * script exists to catch the SHAPE of a mistake at build time, with a message
 * explaining what to do instead — so the failure arrives in a pull request
 * rather than as a puzzling empty result set at runtime.
 */

const SRC = join(process.cwd(), 'src');

interface Rule {
  name: string;
  applies: (relativePath: string) => boolean;
  pattern: RegExp;
  message: string;
}

// Compared against both separators so rules behave identically on Windows and
// on a Linux CI runner.
const isUnder = (path: string, ...segments: string[]) =>
  path.startsWith(`${segments.join(sep)}${sep}`) || path.startsWith(`${segments.join('/')}/`);

const RULES: Rule[] = [
  {
    name: 'identityDb is auth-only',
    // src/db defines it; src/server/auth is the one sanctioned consumer.
    applies: (p) => !isUnder(p, 'server', 'auth') && !isUnder(p, 'db'),
    pattern: /\bidentityDb\b/,
    message:
      '`identityDb` is the raw, unscoped handle and exists only for better-auth.\n' +
      'Use withOrg() for league data, or withSystem() for identity lookups.',
  },
  {
    name: 'withSystem is restricted',
    applies: (p) =>
      !isUnder(p, 'server', 'auth') && !isUnder(p, 'server', 'tenancy') && !isUnder(p, 'db'),
    pattern: /\bwithSystem\s*\(/,
    message:
      '`withSystem()` runs with no league context, so RLS denies every tenant table.\n' +
      'Its only legitimate uses are resolving a hostname to a league and looking up a\n' +
      'session — both of which happen before a league is known. Use withOrg() instead.',
  },
  {
    name: 'no direct driver access',
    applies: (p) => !isUnder(p, 'db'),
    pattern: /from\s+['"](?:pg|drizzle-orm\/node-postgres)['"]/,
    message:
      'Opening a connection outside src/db bypasses withOrg(), and therefore bypasses\n' +
      'row-level security entirely. Import from @/db instead.',
  },
  {
    name: 'services must scope their queries',
    applies: (p) => isUnder(p, 'server', 'services'),
    pattern: /^(?![\s\S]*\bwithOrg\b)[\s\S]*from\s+['"]@\/db\/schema['"]/,
    message:
      'A service that imports table definitions but never calls withOrg() is querying\n' +
      'without a league context. Wrap the query in withOrg(orgId, ...).',
  },
  {
    /**
     * The authorization matrix is only worth having if something calls it.
     *
     * Today `can()` and `assertCan()` have no call sites at all — the matrix is
     * fully tested and completely dormant, because no write path exists yet.
     * The risk is the FIRST write added: nothing would notice that it skipped
     * authorization. This rule makes that omission fail the build.
     *
     * A service that accepts a Principal is, by definition, doing something on
     * behalf of a user — so it must consult the matrix.
     */
    name: 'services taking a Principal must authorize',
    applies: (p) => isUnder(p, 'server', 'services'),
    pattern: /^(?![\s\S]*\b(?:assertCan|can)\s*\()[\s\S]*\bPrincipal\b/,
    message:
      'This service accepts a Principal but never calls can() or assertCan().\n' +
      'Row-level security scopes the query to the right league; it does NOT decide\n' +
      'whether this caller had any business making it. Add an authorization check.',
  },
  {
    /**
     * Writes must be authorized. RLS confines a write to the caller's league —
     * it has no opinion on whether that caller may write at all, so a PLAYER
     * could otherwise mutate their own league's data freely.
     */
    name: 'service writes must be authorized',
    applies: (p) => isUnder(p, 'server', 'services'),
    pattern: /^(?![\s\S]*\b(?:assertCan|can)\s*\()[\s\S]*\.(?:insert|update|delete)\s*\(/,
    message:
      'This service performs a write but never calls can() or assertCan().\n' +
      'Every mutation must pass the permission matrix before it reaches the database.',
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/**
 * Removes comments so that a rule name mentioned in documentation does not
 * report itself. Uses TypeScript's own scanner rather than regex.
 *
 * The previous implementation stripped comments BEFORE strings, with a line
 * comment pattern that only excused a preceding colon (to spare `https://`).
 * A `//` inside a string literal — `'see the README // for details'` — was
 * therefore deleted along with the rest of the line INCLUDING the closing
 * quote. The later quote-stripping passes then re-paired quotes across the
 * wrong boundaries and silently deleted arbitrary spans of real code. Any rule
 * pattern inside a deleted span went unseen and the guard reported success on a
 * file that violated it — a false negative in the check that is supposed to
 * enforce the withOrg()-only data path.
 *
 * Strings are deliberately KEPT. Two of the rules match import specifiers,
 * which are string literals, so stripping them would break those rules
 * entirely. A rule name appearing inside a string is a false positive, which
 * merely fails the build and invites a look — the safe direction to err.
 */
function stripComments(source: string): string {
  // skipTrivia: false so comments are reported as tokens we can locate.
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.JSX,
    source,
  );

  // Blank the comment ranges in place rather than rebuilding the file from
  // tokens. Reconstruction would insert or lose whitespace and break any rule
  // whose pattern spans tokens — `.insert(` becoming `. insert (`, for example.
  // Overwriting with spaces preserves every offset, so line numbers and all
  // other text survive exactly.
  const chars = [...source];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenStart();
      const end = scanner.getTextPos();
      for (let i = start; i < end; i++) {
        // Newlines are kept so multi-line comments do not merge the lines
        // around them.
        if (chars[i] !== '\n') chars[i] = ' ';
      }
    }
    token = scanner.scan();
  }
  return chars.join('');
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');

const violations: string[] = [];

for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const raw = readFileSync(file, 'utf8');

  for (const rule of RULES) {
    if (!rule.applies(rel)) continue;

    // One haystack for every rule now. Strings survive comment-stripping, so
    // the import-specifier rules work against the same text as the rest — no
    // special case, and nothing depends on a rule's name.
    if (rule.pattern.test(stripComments(raw))) {
      violations.push(`  src${sep}${rel}\n    ✗ ${rule.name}\n${indent(rule.message)}`);
    }
  }
}

if (violations.length > 0) {
  console.error('\n✗ tenancy guard failed\n');
  console.error(violations.join('\n\n'));
  console.error('');
  process.exit(1);
}

console.log('✓ tenancy guard passed');
