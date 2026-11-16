/**
 * Reads bun's JUnit reports for the perf tier (`scripts/ci/perf-tier.sh`). Prints tab-separated lines, no JSON:
 * the caller is a bash script.
 *
 *   failed  <junit>...            file <TAB> milliseconds <TAB> test name        one line per FAILED test
 *   slowest <n> <junit>...        milliseconds <TAB> file <TAB> test name        the n slowest tests, slowest first
 *   times   <file> <junit>...     milliseconds <TAB> pass|FAIL|skip <TAB> name   every test of one file
 *
 * A report that does not exist or does not parse contributes nothing: the caller treats "the process failed and
 * no failed test was named" as "the whole share failed", so a crash can never read as a pass.
 */
import { existsSync, readFileSync } from 'node:fs';

type Verdict = 'pass' | 'FAIL' | 'skip';
interface Case {
  readonly file: string;
  readonly name: string;
  readonly ms: number;
  readonly verdict: Verdict;
}

const unescape = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');

const attributes = (text: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const [, key, value] of text.matchAll(/([\w:-]+)="([^"]*)"/g)) found[key as string] = unescape(value as string);
  return found;
};

/** Every test case of one report. Exported for the test. */
export const parseCases = (xml: string): Case[] => {
  const cases: Case[] = [];
  for (const match of xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(match[1] ?? '');
    const body = match[2] ?? '';
    const failed = /<(failure|error)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    cases.push({
      file: attrs.file ?? '',
      name: attrs.name ?? '',
      ms: Math.round(Number(attrs.time ?? '0') * 1000),
      verdict: failed ? 'FAIL' : skipped ? 'skip' : 'pass',
    });
  }
  return cases;
};

const load = (paths: readonly string[]): Case[] =>
  paths.flatMap(path => (existsSync(path) ? parseCases(readFileSync(path, 'utf8')) : []));

const [command, ...rest] = process.argv.slice(2);
const line = (...cells: (string | number)[]): void => {
  console.log(cells.map(cell => String(cell).replace(/[\t\r\n]+/g, ' ')).join('\t'));
};

if (import.meta.main) {
  if (command === 'failed') {
    for (const c of load(rest).filter(c => c.verdict === 'FAIL')) line(c.file, c.ms, c.name);
  } else if (command === 'slowest') {
    const [count, ...paths] = rest;
    const limit = Number(count);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('slowest needs a positive count');
    for (const c of [...load(paths)].sort((a, b) => b.ms - a.ms).slice(0, limit)) line(c.ms, c.file, c.name);
  } else if (command === 'times') {
    const [file, ...paths] = rest;
    for (const c of load(paths).filter(c => c.file === file)) line(c.ms, c.verdict, c.name);
  } else {
    console.error('usage: perf-junit.ts failed <junit>... | slowest <n> <junit>... | times <file> <junit>...');
    process.exit(2);
  }
}
