import type { RedactionScope } from '@ferretry/kernel/contract';

/**
 * A UNIFIED DIFF AS IT LEAVES THE DAEMON, with every secret the read's scope knows replaced.
 *
 * This is the outbound projection and nothing else: the diff bytes the service builds (and the snapshots they
 * come from) are never touched, so nothing that consumes a diff is corrupted. The secrets-policy refusal
 * (denied / ignored → 403) is a gate that runs before this and stays as it is; this adds to it.
 *
 * A secret that spans lines is not one run of text in a diff, because every line carries its marker (`+`, `-` or a
 * space) and a changed value is split across them. So each hunk is looked at three ways and the coverage is the
 * UNION (the way Terminals masks each row and the whole capture): runs of lines with the SAME marker, the hunk's
 * OLD side (context + removed, in order) and its NEW side (context + added). Each look is matched as one text by the
 * scope, so a value whose first and last lines are unchanged context and whose body is added is found whole.
 *
 * Hunks are not looked at alone. The section heading git prints after a hunk header's closing `@@` is a file line the
 * diff shows, and when only one line hides between two hunks it sits right after the previous hunk's trailing context
 * and right before this hunk's leading context. So the hunks of one file are joined into one group whenever the next
 * one has a heading (its trailing context, the heading and its body are looked at as one), and a value laid over
 * them is found whole. The heading stays on the wire as git printed it, masked where it is covered.
 *
 * Masking is POSITIONAL: a covered character becomes `*` on the diff line it came from, one mask per original
 * line, so line counts and hunk headers stay true. Headers and hunk headers (which can carry a source line) are
 * masked one line at a time.
 *
 * Positions are UTF-16 code UNITS, exactly as the scope reports them (Vault's own starring walks units): a character
 * outside the BMP is two places, never one. A CRLF line is matched both as it is and without its `\r` (a value
 * stored with `\r` and one stored with LF are both found); the `\r` is kept in the output.
 */
export function redactedDiffText(diff: string, scope: RedactionScope): string {
  return redactedDiff(diff, scope).text;
}

/**
 * The masked diff and whether the scope reported ANY coverage. The second answer is the one a refusal rests on: it
 * never depends on how the masked text compares to the original.
 */
export function redactedDiff(
  diff: string,
  scope: RedactionScope,
): { readonly text: string; readonly covered: boolean } {
  const out: string[] = [];
  let covered = false;
  let inHunk = false;
  // The entries of the hunks that are looked at together, and of the hunk being read.
  let group: Body[] = [];
  let hunk: Body[] = [];
  // The old-file line the previous hunk of this file stopped at.
  let end: number | undefined;

  const closeHunk = (): void => {
    // A heading with no body after it is only the header line, which was masked on its own.
    if (!(hunk.length === 1 && hunk[0]?.heading !== undefined)) group.push(...hunk);
    hunk = [];
  };

  const flushGroup = (): void => {
    const rows = coverage(group, scope);
    for (const [index, entry] of group.entries()) {
      if (entry.marker === '\\') {
        const masked = maskLine(entry.line, scope);
        if (masked !== entry.line) covered = true;
        out[entry.at] = masked;
        continue;
      }
      const row = rows[index] ?? [];
      if (!row.includes(true)) continue;
      covered = true;
      const text = starred(entry.text, row);
      out[entry.at] =
        entry.heading === undefined
          ? entry.line.charAt(0) + text
          : unionHeading(out[entry.at] ?? '', entry.heading, text);
    }
    group = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false;
    const lead = line.charAt(0);
    // An empty line inside a hunk is a blank context line (`diff.suppressBlankEmpty`), not the end of the run.
    if (inHunk && (lead === ' ' || lead === '+' || lead === '-' || line === '')) {
      out.push(line);
      hunk.push({ line, marker: line === '' ? ' ' : (lead as Marker), text: line.slice(1), at: out.length - 1 });
      continue;
    }
    // A `\ No newline at end of file` line sits inside the hunk at its position: it is not content, so it never
    // splits the run and is left out of every look, but it is still carried through the scope.
    if (inHunk && lead === '\\') {
      out.push(line);
      hunk.push({ line, marker: '\\', text: '', at: out.length - 1 });
      continue;
    }
    closeHunk();
    const masked = maskLine(line, scope);
    if (masked !== line) covered = true;
    out.push(masked);
    if (!line.startsWith('@@')) {
      flushGroup();
      end = undefined;
      continue;
    }
    inHunk = true;
    // The section heading is the file line before the hunk, so it reads as the context line that comes before the first
    // body line, on the old side and the new side alike: it is fed to the hunk as a context entry, and what it covers
    // is written back onto the heading's own positions.
    const heading = headingOf(line);
    const span = spanOf(line);
    const gap = span !== undefined && end !== undefined ? span.start - end - 1 : 0;
    // Hidden lines sit between this hunk and the one before it. Join the two when the heading can sit in the gap.
    const joined = heading !== undefined && gap >= 1;
    if (!joined) flushGroup();
    end = span?.end;
    if (heading === undefined) continue;
    const entry: Body = {
      line: ` ${heading.text}`,
      marker: ' ',
      text: heading.text,
      at: out.length - 1,
      heading: heading.start,
    };
    // With more than one hidden line the heading may also be the first of them, right after the previous hunk's
    // trailing context, so it is offered there as well (with exactly one it is both, and stands once).
    if (joined && gap >= 2) group.push(entry);
    hunk.push(entry);
  }
  closeHunk();
  flushGroup();
  return { text: out.join('\n'), covered };
}

type Marker = ' ' | '+' | '-' | '\\';

/** The section heading of a hunk header (`@@ -3,3 +3,5 @@ heading`): its text and where it starts. */
function headingOf(line: string): { readonly text: string; readonly start: number } | undefined {
  const match = /^@@+ .*? @@+ /.exec(line);
  if (match === null) return undefined;
  const start = match[0].length;
  const text = line.slice(start);
  return text === '' ? undefined : { text, start };
}

/** The old-file lines a hunk header covers (`-3,3`): the first it shows and the last. A combined diff has none. */
function spanOf(line: string): { readonly start: number; readonly end: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
  if (match === null) return undefined;
  const first = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  // A hunk of no old lines (`-5,0`) sits after line 5.
  return count === 0 ? { start: first + 1, end: first } : { start: first, end: first + count - 1 };
}

/** The header line with every heading character either look covered starred (units line up: same length). */
function unionHeading(current: string, start: number, viaHunk: string): string {
  let out = current.slice(0, start);
  for (let unit = start; unit < current.length; unit++) {
    const mine = current.charAt(unit);
    const theirs = viaHunk.charAt(unit - start);
    out += theirs === '*' && mine !== '\r' ? '*' : mine;
  }
  return out;
}

/** One header line masked the way the body is: a positional `*` per covered character, same length. */
function maskLine(line: string, scope: RedactionScope): string {
  const [masked] = scope.lines([`${line}\n`]);
  return masked === undefined ? line : masked.slice(0, line.length);
}

interface Body {
  readonly line: string;
  readonly marker: Marker;
  readonly text: string;
  /** Where the entry's line is in the output. A heading's is the hunk header line it was read from. */
  readonly at: number;
  /** Set on the hunk header's section heading, standing in as a context line: where it starts in the header. */
  readonly heading?: number;
}

/** The text with every covered unit a `*` (a `\r` is kept). */
function starred(text: string, row: readonly boolean[]): string {
  // Walk code UNITS, as the scope does: a code-point walk would shift the mask after any astral character.
  let masked = '';
  for (let unit = 0; unit < text.length; unit++) {
    const char = text.charAt(unit);
    masked += row[unit] === true && char !== '\r' ? '*' : char;
  }
  return masked;
}

/**
 * Which characters of each entry a look covers, entry by entry (the scope keeps every string's length). A CRLF line
 * is looked at three ways and the coverage is the union: as it is (a value stored with `\r` in it is found), without
 * its `\r` (a value stored with LF is found) and with a CRLF break (a value stored with CRLF, in an LF diff). Only the break differs between the looks, so positions
 * line up.
 */
function look(entries: readonly number[], body: readonly Body[], scope: RedactionScope, covered: boolean[][]): void {
  if (entries.length === 0) return;
  const raws = entries.map(at => `${body[at]?.text ?? ''}\n`);
  const stripped = raws.map(text => text.replace(/\r?\n$/, '\n'));
  const expanded = stripped.map(text => `${text.slice(0, -1)}\r\n`);
  for (const texts of [raws, stripped, expanded]) {
    const masked = scope.lines(texts);
    entries.forEach((at, position) => {
      const before = texts[position] ?? '';
      const after = masked[position] ?? before;
      const row = covered[at];
      if (row === undefined) return;
      const content = (body[at]?.text ?? '').replace(/\r$/, '').length;
      for (let unit = 0; unit < content; unit++) if (after[unit] !== before[unit]) row[unit] = true;
    });
  }
}

/** The coverage of a group of hunks, one row of booleans per entry. */
function coverage(body: readonly Body[], scope: RedactionScope): boolean[][] {
  const covered = body.map(entry => Array.from<boolean>({ length: entry.text.length }).fill(false));
  if (body.length === 0) return covered;
  // The no-newline marker is not content: it takes no part in any look.
  const all = body.flatMap((entry, at) => (entry.marker === '\\' ? [] : [at]));
  // The same-marker runs, the old side and the new side.
  let run: number[] = [];
  for (const at of all) {
    if (run.length > 0 && body[run[0] ?? 0]?.marker !== body[at]?.marker) {
      look(run, body, scope, covered);
      run = [];
    }
    run.push(at);
  }
  look(run, body, scope, covered);
  look(
    all.filter(at => body[at]?.marker !== '+'),
    body,
    scope,
    covered,
  );
  look(
    all.filter(at => body[at]?.marker !== '-'),
    body,
    scope,
    covered,
  );
  // The same text on both sides of a hunk is the same text: a removed line takes the coverage of an added line that
  // reads the same (and the other way round), so a partial copy never sits in clear beside its own mask.
  const seen = new Map<string, boolean[]>();
  for (const [at, entry] of body.entries()) {
    const row = covered[at];
    if (row === undefined || (entry.marker !== '+' && entry.marker !== '-')) continue;
    const peer = seen.get(entry.text);
    if (peer === undefined) seen.set(entry.text, row);
    else for (const [index, unit] of row.entries()) peer[index] = unit || peer[index] === true;
  }
  for (const [at, entry] of body.entries()) {
    const row = covered[at];
    const peer = entry.marker === '+' || entry.marker === '-' ? seen.get(entry.text) : undefined;
    if (row !== undefined && peer !== undefined) for (const [index, unit] of peer.entries()) row[index] = unit;
  }
  return covered;
}
