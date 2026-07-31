import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/** Prevents a rule name mentioned in a doc comment reporting itself. */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
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

    // The services rule needs whole-file context including imports.
    const haystack =
      rule.name === 'services must scope their queries' ? raw : stripCommentsAndStrings(raw);

    if (rule.pattern.test(haystack)) {
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
