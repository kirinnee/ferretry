/**
 * The e2e tier's per-journey ceiling, enforced: no journey outside the slow tier may give itself more
 * time than the runner's `--timeout`.
 *
 * WHY. Bun's `--timeout` is only a DEFAULT: a third argument to `it` replaces it. Two pull-request
 * journeys declared 600 and 900 seconds, and each hung a shard for that long when its browser went
 * silent. A journey that needs longer than the ceiling is waiting on purpose, and that is what the
 * `[slow]` title suffix is for (scripts/ci/e2e-shards.ts) — those journeys keep their own budgets
 * and run in `E2E Slow`, never on a pull request.
 *
 * HOW. Bun offers no hook to clamp a test's timeout and this repository's TypeScript has no stable
 * parser API, so this reads the source the way the formatter lays it out: an `it(`/`test(` call, its
 * title, and the arguments after the callback's closing `}` at the call's own indentation. A call it
 * cannot read fails the check rather than passing it, and so does a `setDefaultTimeout` above the
 * ceiling, because that default is every journey's timeout in its file.
 *
 * Usage: bun scripts/test/e2e-journey-timeouts.ts <ceiling-ms> <file>…
 */

const SLOW_TAG = '[slow]';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly problem: string;
}

const number = (text: string): number => Number(text.replaceAll('_', ''));
const indentOf = (line: string): number => line.length - line.trimStart().length;

const LITERAL = /^(['"`])((?:\\.|(?!\1).)*)\1/u;

function titleAt(lines: readonly string[], index: number): string | undefined {
  // `it.each([...])('title %s', …)`: the title follows the table.
  const table = /\b(?:it|test)\.each\(.*\)\(\s*(.*)$/u.exec(lines[index] ?? '');
  if (table !== null) return LITERAL.exec(table[1] ?? '')?.[2];
  const opening = /\b(?:it|test)(?:\.(?:only|skip|todo|if\([^)]*\)|skipIf\([^)]*\)))?\(\s*(.*)$/u.exec(
    lines[index] ?? '',
  );
  if (opening === null) return undefined;
  const rest = opening[1] === '' ? (lines[index + 1] ?? '').trim() : (opening[1] ?? '');
  return LITERAL.exec(rest)?.[2];
}

function timeoutOf(lines: readonly string[], index: number): number | 'unreadable' | undefined {
  // `it('title', () =>\n  call(async () => {\n  }), 600_000);` closes one level in; a block callback at the call's own level.
  const expressionCallback = /=>\s*$/u.test(lines[index] ?? '');
  const indent = indentOf(lines[index] ?? '') + (expressionCallback ? 2 : 0);
  for (let at = index + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.trim() === '' || indentOf(line) !== indent) continue;
    const tail = line.trim();
    if (expressionCallback) {
      // The expression itself (`call(async () => {`) opens at this level too.
      if (!/^[})]/u.test(tail)) continue;
      if (/^\}\)+\s*;?$/u.test(tail)) return undefined;
      const after = /^\}\)+,\s*([0-9_]+)\s*\)\s*;?$/u.exec(tail);
      return after?.[1] === undefined ? 'unreadable' : number(after[1]);
    }
    // `});` — no timeout; `}, 600_000);` — inline; `},` then the timeout alone on the next line.
    if (/^\}\)\s*;?$/u.test(tail)) return undefined;
    // `it(\n  'title',\n  () => …,\n  600_000,\n);` — an expression callback: the timeout, if any, is last.
    if (/^\)\s*;?$/u.test(tail)) {
      const last = /^([0-9_]+),?$/u.exec((lines[at - 1] ?? '').trim());
      return last?.[1] === undefined ? undefined : number(last[1]);
    }
    const inline = /^\},\s*([0-9_]+)\s*\)\s*;?$/u.exec(tail);
    if (inline?.[1] !== undefined) return number(inline[1]);
    if (/^\},?$/u.test(tail)) {
      const next = /^([0-9_]+),?$/u.exec((lines[at + 1] ?? '').trim());
      if (next?.[1] !== undefined) return number(next[1]);
      if (/^\)\s*;?$/u.test((lines[at + 1] ?? '').trim())) return undefined;
    }
    return 'unreadable';
  }
  return 'unreadable';
}

export function findOverlongJourneys(file: string, source: string, ceilingMs: number): readonly Finding[] {
  const lines = source.split('\n');
  const findings: Finding[] = [];
  lines.forEach((line, index) => {
    const defaulted = /\bsetDefaultTimeout\(\s*([0-9_]+)\s*\)/u.exec(line);
    if (defaulted?.[1] !== undefined && number(defaulted[1]) > ceilingMs)
      findings.push({
        file,
        line: index + 1,
        problem: `setDefaultTimeout(${defaulted[1]}) is above the ${String(ceilingMs)}ms journey ceiling`,
      });
    if (!/^\s*(?:it|test)(?:\.[A-Za-z]+(?:\([^)]*\))?)?\(/u.test(line)) return;
    const title = titleAt(lines, index);
    if (title === undefined) {
      findings.push({ file, line: index + 1, problem: 'a journey whose title is not a plain string literal' });
      return;
    }
    if (title.endsWith(SLOW_TAG)) return;
    const timeout = timeoutOf(lines, index);
    if (timeout === 'unreadable')
      findings.push({ file, line: index + 1, problem: `"${title}": its timeout argument could not be read` });
    else if (timeout !== undefined && timeout > ceilingMs)
      findings.push({
        file,
        line: index + 1,
        problem: `"${title}" gives itself ${String(timeout)}ms, above the ${String(ceilingMs)}ms journey ceiling — speed it up, or end its title in ${SLOW_TAG}`,
      });
  });
  return findings;
}

if (import.meta.main) {
  const [ceiling, ...files] = process.argv.slice(2);
  const ceilingMs = Number(ceiling);
  if (!Number.isInteger(ceilingMs) || ceilingMs <= 0 || files.length === 0) {
    process.stderr.write('usage: bun scripts/test/e2e-journey-timeouts.ts <ceiling-ms> <file>…\n');
    process.exit(2);
  }
  const findings = (
    await Promise.all(files.map(async file => findOverlongJourneys(file, await Bun.file(file).text(), ceilingMs)))
  ).flat();
  for (const finding of findings)
    process.stderr.write(`❌ ${finding.file}:${String(finding.line)}: ${finding.problem}\n`);
  if (findings.length > 0) process.exit(1);
}
