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
 * Masking is POSITIONAL: a covered character becomes `*` on the diff line it came from, one mask per original
 * line, so line counts and hunk headers stay true. Headers and hunk headers (which can carry a source line) are
 * masked one line at a time.
 */
export function redactedDiffText(diff: string, scope: RedactionScope): string {
  const out: string[] = [];
  let body: Body[] = [];
  let inHunk = false;

  const flush = (): void => {
    out.push(...maskHunk(body, scope));
    body = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false;
    const lead = line.charAt(0);
    // An empty line inside a hunk is a blank context line (`diff.suppressBlankEmpty`), not the end of the run.
    if (inHunk && (lead === ' ' || lead === '+' || lead === '-' || line === '')) {
      body.push({ line, marker: line === '' ? ' ' : (lead as Marker), text: line.slice(1) });
      continue;
    }
    // A `\ No newline at end of file` line sits inside the hunk at its position: it is not content, so it never
    // splits the run and is left out of every look, but it is still carried through the scope.
    if (inHunk && lead === '\\') {
      body.push({ line, marker: '\\', text: '' });
      continue;
    }
    flush();
    if (line.startsWith('@@')) inHunk = true;
    out.push(maskLine(line, scope));
  }
  flush();
  return out.join('\n');
}

type Marker = ' ' | '+' | '-' | '\\';

/** One header line masked the way the body is: a positional `*` per covered character, same length. */
function maskLine(line: string, scope: RedactionScope): string {
  const [masked] = scope.lines([line + '\n']);
  return masked === undefined ? line : masked.slice(0, line.length);
}
interface Body {
  readonly line: string;
  readonly marker: Marker;
  readonly text: string;
}

/** Which characters of each entry a look covers, entry by entry (the scope keeps every string's length). */
function look(entries: readonly number[], body: readonly Body[], scope: RedactionScope, covered: boolean[][]): void {
  if (entries.length === 0) return;
  const texts = entries.map(at => (body[at]?.text ?? '') + '\n');
  const masked = scope.lines(texts);
  entries.forEach((at, position) => {
    const before = texts[position] ?? '';
    const after = masked[position] ?? before;
    const row = covered[at];
    if (row === undefined) return;
    for (let char = 0; char < before.length - 1; char++) if (after[char] !== before[char]) row[char] = true;
  });
}

function maskHunk(body: readonly Body[], scope: RedactionScope): string[] {
  if (body.length === 0) return [];
  const covered = body.map(entry => Array.from<boolean>({ length: entry.text.length }).fill(false));
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
  return body.map((entry, at) => {
    const row = covered[at] ?? [];
    if (entry.marker === '\\') return maskLine(entry.line, scope);
    if (!row.includes(true)) return entry.line;
    return entry.line.charAt(0) + [...entry.text].map((char, index) => (row[index] === true ? '*' : char)).join('');
  });
}
