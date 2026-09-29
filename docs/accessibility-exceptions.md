# Accessibility exceptions

This file records every colour pair in the product that falls short of a
contrast target, with its measured ratio. An exception that is not written down
is not a decision — it is drift, and the difference is only visible if somebody
wrote it down.

## The decision behind these

The product reproduces a reference visual design **exactly**, including its
colours. The owner decided on 2026-09-17 that colours are **not** adjusted to
meet contrast targets: matching the reference wins. That supersedes the
project's earlier aim of 7:1 (WCAG AAA) for body text.

So this is not a list of negotiated compromises. It is an honest record of
where the product sits against a standard it deliberately chose not to meet,
so that anyone who later wants to revisit the decision knows exactly what it
costs and what changing it would touch.

## What is kept regardless

None of these costs anything in visual fidelity, so none of it is affected by
the decision above:

- **No status is ever conveyed by colour alone.** The league has ~6,000
  members, so roughly 480 have red/green colour deficiency. Result pills carry
  the letter W, D or L; status tags carry a word; status pills carry an icon
  and screen-reader text.
- A visible keyboard focus ring, a skip link, labelled navigation landmarks,
  zoom left enabled, and the standings table's screen-reader semantics
  (`<caption>`, row headers, abbreviation expansions).

## Measured ratios

WCAG 2.2 thresholds: **4.5:1** for normal text (AA), **3:1** for large text
(18.66px bold or 24px regular) and for UI components, **7:1** for AAA. Ratios
computed from the sRGB values with the WCAG relative-luminance formula, on
2026-09-29.

### Below AA (4.5:1)

| Pair | Where it appears | Ratio |
| --- | --- | --- |
| `--subtle-foreground` on `--background` | faint text on the page | **2.85:1** |
| `--subtle-foreground` on `--muted` | faint text on a table header | **2.95:1** |
| `--subtle-foreground` on `--card` | rank numbers, match metadata | **3.10:1** |
| white on `--result-draw` | the D form pill | **3.31:1** |
| white on `--result-win` | the W form pill | **4.00:1** |
| white on `--result-loss` | the L form pill | **4.43:1** |

The form pills are 11px bold, which does **not** count as large text, so the
4.5:1 threshold applies to them. The two faint-text ratios on tinted surfaces
fall below even the 3:1 large-text threshold.

### Meets AA, below the former 7:1 target

| Pair | Where it appears | Ratio |
| --- | --- | --- |
| `--muted-foreground` on `--background` | secondary text on the page | 5.11:1 |
| `--status-caution` on its background | amber tag | 5.27:1 |
| `--muted-foreground` on `--muted` | table header labels | 5.30:1 |
| `--muted-foreground` on `--card` | secondary text on cards | 5.56:1 |
| `--brand-600` on `--card` | eyebrow labels | 5.94:1 |
| `--status-negative` on its background | red tag, error box | 6.05:1 |
| `--status-positive` on its background | green tag | 6.27:1 |
| `--status-info` on its background | blue tag | 6.59:1 |

### Meets AAA, for reference

Body text on the page (15.36:1) and on cards (16.71:1), links and primary
buttons (9.36:1), the lime call-to-action (10.45:1), and destructive buttons
(7.19:1).

## Not yet measured

This covers the colour **tokens**. Pairs that only exist inside a component —
the navigation text on the dark header, the footer's copy, the per-team crest
colours — are added here as each of those components is built.

## Reversing it

Every pair above traces to one token in `src/app/globals.css`. Bringing the six
below-AA pairs up to 4.5:1 means changing four values: `--n-400` (which feeds
`--subtle-foreground`), `--result-win`, `--result-draw` and `--result-loss`.
Nothing structural depends on the current values.
