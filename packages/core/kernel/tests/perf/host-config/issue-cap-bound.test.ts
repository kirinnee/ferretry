/**
 * The SPEED half of `../../unit/host-config/issue-cap.test.ts`: the checks, the locate walk and the YAML 1.1 tag read,
 * each at the size limit, answer within one hard bound. The answers (the cap on the issues, what is listed and said) are held here at the size limit, and in unit at a small size.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { checkConfigText, countProblems, MAX_CONFIG_ISSUES, moreIssues } from '../../../host/config/check.ts';
import { CONFIG_FILE_MAX_BYTES, readConfigText } from '@ferretry/std/yaml';
import { filled } from '../../unit/host-config/schema-texts.ts';

const BOUND_MS = 1500;

const envDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ command: z.string().optional(), env: z.record(z.string(), z.string()).optional() }),
  axis: 'configure',
  loosens: () => [],
});

/** Fake only: a key shape assembled at run time. */
const KEYLIKE = `${'sk'}-${'ant'}-${'A1B2'.repeat(10)}`;

/**
 * The BEST time of a few attempts at a check: a bound on the clock measures the box as much as the code
 * (2.2 s under a loaded run, 0.9 s alone), so a quadratic path fails every attempt and a busy moment fails one.
 */
function checked(text: string) {
  let ms = Number.POSITIVE_INFINITY;
  let result = checkConfigText(envDef, 'voice.yaml', text, 'fy');
  for (let attempt = 0; attempt < 3 && ms >= BOUND_MS; attempt += 1) {
    const started = performance.now();
    result = checkConfigText(envDef, 'voice.yaml', text, 'fy');
    ms = Math.min(ms, performance.now() - started);
  }
  return { result, ms };
}

/** The issues of a refused check, or a failure. */
function issuesOf(result: ReturnType<typeof checkConfigText>) {
  if (result.ok) throw new Error('expected the text to be refused');
  return result.issues;
}

describe('one check at the size limit answers within the bound, and lists at most MAX_CONFIG_ISSUES', () => {
  /** `total`: every problem the text holds; `lines`: one per entry line; `undefined`: more than the cap. */
  const cases: readonly (readonly [label: string, text: string, total: number | 'lines' | undefined])[] = [
    ['syntax errors', filled(CONFIG_FILE_MAX_BYTES, '', () => '"\n'), undefined],
    ['duplicate keys', filled(CONFIG_FILE_MAX_BYTES, '', () => 'env: {}\n'), CONFIG_FILE_MAX_BYTES / 8 - 1],
    [
      'raw secrets',
      filled(CONFIG_FILE_MAX_BYTES, 'env:\n', index => `  K${index.toString(36)}: ${KEYLIKE}\n`),
      'lines',
    ],
    ['schema issues', filled(CONFIG_FILE_MAX_BYTES, 'env:\n', index => `  K${index.toString(36)}: []\n`), 'lines'],
  ];
  for (const [label, text, expected] of cases) {
    test(`T-0033 ${label}: ${String(MAX_CONFIG_ISSUES)} listed, the rest counted, in under ${BOUND_MS} ms`, () => {
      const { result, ms } = checked(text);
      expect(ms).toBeLessThan(BOUND_MS);
      const issues = issuesOf(result);
      expect(issues).toHaveLength(MAX_CONFIG_ISSUES + 1);
      // One per line under env (or per line of the file), located: every listed one has a line.
      expect(issues.slice(0, MAX_CONFIG_ISSUES).every(issue => issue.line !== undefined)).toBe(true);
      const total =
        expected === 'lines' ? text.split('\n').length - 2 : expected === undefined ? countProblems(issues) : expected;
      expect(total).toBeGreaterThan(MAX_CONFIG_ISSUES);
      expect(countProblems(issues)).toBe(total);
      expect(issues.at(-1)).toEqual(moreIssues('voice.yaml', total - MAX_CONFIG_ISSUES));
      // The answer is a few KiB, and never quotes a key.
      expect(JSON.stringify(result).length).toBeLessThan(32 * 1024);
      expect(JSON.stringify(result)).not.toContain(KEYLIKE);
    });
  }

  test(`T-0033 a long list of unknown keys names ten of them and counts the rest, in under ${BOUND_MS} ms`, () => {
    const text = filled(CONFIG_FILE_MAX_BYTES, '', index => `zz${index.toString(36)}: 1\n`);
    const { result, ms } = checked(text);
    expect(ms).toBeLessThan(BOUND_MS);
    const issues = issuesOf(result);
    expect(issues).toHaveLength(1);
    const keys = text.split('\n').length - 1;
    expect(issues[0]?.message).toBe(
      `Unrecognized keys: ${Array.from({ length: 10 }, (_, index) => `"zz${index.toString(36)}"`).join(', ')} and ${String(keys - 10)} more`,
    );
    expect(issues[0]?.fix).toStartWith('remove "zz0", "zz1"');
    expect(issues[0]?.line).toBe(1);
    expect(JSON.stringify(result).length).toBeLessThan(4 * 1024);
  });

  test(`T-0033 a 250 KiB key is cut in the message and in the fix, and the answer stays small, in under ${BOUND_MS} ms`, () => {
    const key = 'k'.repeat(250 * 1024);
    const { result, ms } = checked(`? ${key}\n: 1\n`);
    expect(ms).toBeLessThan(BOUND_MS);
    const [issue] = issuesOf(result);
    const cut = `"${'k'.repeat(64)}…" (${String(key.length)} characters)`;
    expect(issue?.message).toBe(`Unrecognized key: ${cut}`);
    expect(issue?.fix).toBe(`remove ${cut} — this file has no such setting`);
    expect(JSON.stringify(result).length).toBeLessThan(2 * 1024);
  });
});

describe('locate walks a path one step per part', () => {
  test('20 000 entries of one mapping, each located, in under the bound and at its own line', () => {
    const text = filled(CONFIG_FILE_MAX_BYTES, 'a:\n  b:\n', index => `    k${index.toString(36)}: x\n`);
    const read = readConfigText(text);
    if (!read.ok) throw new Error('expected the text to read');
    const entries = text.split('\n').length - 3;
    expect(entries).toBeGreaterThan(20_000);
    const started = performance.now();
    for (let index = 0; index < entries; index += 1) read.read.locate(['a', 'b', `k${index.toString(36)}`]);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
    expect(read.read.locate(['a', 'b', 'k0'])).toEqual({ line: 3, column: 5 });
    expect(read.read.locate(['a', 'b', `k${(entries - 1).toString(36)}`])).toEqual({ line: entries + 2, column: 5 });
    // A key that is not there: its parent.
    expect(read.read.locate(['a', 'b', 'nope', 'deeper'])).toEqual({ line: 2, column: 3 });
  });
});

describe('a YAML 1.1 tag is not resolved inside the parse', () => {
  test('a !!omap of many short keys at the cap reads in under the bound (it took 7–10 s resolved)', () => {
    const text = `${filled(CONFIG_FILE_MAX_BYTES - 1, 'a: !!omap [', index => `${index.toString(36)}:,`)}]`;
    const started = performance.now();
    const read = readConfigText(text);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
    expect(read.ok).toBe(true);
  });
});
