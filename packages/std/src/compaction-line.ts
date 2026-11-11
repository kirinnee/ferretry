/**
 * Claude's compaction status line — the ONE grammar every pane reader shares (&B188).
 *
 * The terminals plugin reads a frame to decide whether a harness is working (a send must never be typed into a
 * compacting composer), Ferrets reads the same frame for the live compaction card, and Warden reads it for its
 * liveness reflex. They live in different packages, and a shape one of them takes and another misses lets a send be
 * typed into a compacting composer — so the grammar has exactly one owner, here, and they all import it.
 *
 * It matches the WHOLE line and only Claude's real wording: a spinner glyph (the `·` and ASCII `*` idle ticks, or one
 * of the animated glyphs), exactly `Compacting conversation`, an ellipsis (`…` or `...`), then nothing or a
 * parenthetical that opens on the elapsed clock, a token count or the interrupt hint alone — `(3s)`,
 * `(7m 14s · ↓ 37.4k tokens)`, `(esc to interrupt)`, or any of them clipped on a narrow pane. Prose such as
 * `  * Compacting the notes… is next` therefore never reads as a compaction, however close to the composer it sits.
 *
 * Multi-line (`m`) so a reader can test a block of rows at once; every reader that tests one line gets the same answer.
 * Whitespace is `[^\S\n]`, never `\s`, so a match can never run across a line break.
 */
export const COMPACTING_LINE =
  /^[^\S\n]*[·*✻✳✶✽✢∗✦✧][^\S\n]+Compacting conversation(?:…|\.\.\.)(?:[^\S\n]*\([^\S\n]*(?:\d+[^\S\n]*[hms]\b|[\d.,]+k?[^\S\n]*tokens|[Ee]sc to interrupt)[^\n]*)?[^\S\n]*$/mu;
