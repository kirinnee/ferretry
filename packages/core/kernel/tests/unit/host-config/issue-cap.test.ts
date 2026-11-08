/**
 * Review round 7: what one answer about a file may cost and say.
 *
 * - At most {@link MAX_CONFIG_ISSUES} problems are listed — syntax, duplicate keys, raw secrets and schema alike — and
 *   ONE fixed sentence counts the rest; only the listed ones are located, so the cost does not grow with the count.
 * - Locating a problem walks its path, one step per part: 20 000 problems in one mapping are no longer 20 000 scans of
 *   it.
 * - A YAML 1.1 tag (`!!omap`, `!!set`, `!!pairs`, `!!binary`, `!!timestamp`) is not resolved inside the parse.
 * - The agent's listing caps its problems the same way, and every count said is every problem.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import { defineConfig } from '../../../contract/index.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { checkConfigText, countProblems, MAX_CONFIG_ISSUES, moreIssues } from '../../../host/config/check.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { CONFIG_FILE_MAX_BYTES, readConfigText } from '../../../host/config/yaml-text.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { filled } from './schema-texts.ts';
import { captureLog, HOME, manualClock } from './support.ts';

const BOUND_MS = 1500;

/** A file whose `env` is a mapping of strings, like `mcp/<name>.yaml`'s, and nothing else. */
const envDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ command: z.string().optional(), env: z.record(z.string(), z.string()).optional() }),
  axis: 'configure',
  loosens: () => [],
});

/** Fake only: a key shape assembled at run time. */
const KEYLIKE = `${'sk'}-${'ant'}-${'A1B2'.repeat(10)}`;

function checked(text: string) {
  const started = performance.now();
  const result = checkConfigText(envDef, 'voice.yaml', text, 'fy');
  return { result, ms: performance.now() - started };
}

/** The issues of a refused check, or a failure. */
function issuesOf(result: ReturnType<typeof checkConfigText>) {
  if (result.ok) throw new Error('expected the text to be refused');
  return result.issues;
}

describe('one answer lists at most MAX_CONFIG_ISSUES problems, and one sentence counts the rest', () => {
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

  test('the counting sentence is fixed: a count, singular or plural, and nothing of the file', () => {
    expect(moreIssues('a.yaml', 1)).toEqual({
      path: 'a.yaml',
      severity: 'error',
      message: 'and 1 more problem not listed here',
      fix: 'fix the problems listed, then check the file again to see the rest',
    });
    expect(countProblems([moreIssues('a.yaml', 1), { message: 'x' }, moreIssues('a.yaml', 41)])).toBe(43);
  });

  test('exactly MAX_CONFIG_ISSUES problems are all listed, with no counting sentence', () => {
    const text = `env:\n${Array.from({ length: MAX_CONFIG_ISSUES }, (_, index) => `  K${String(index)}: []\n`).join('')}`;
    const issues = issuesOf(checked(text).result);
    expect(issues).toHaveLength(MAX_CONFIG_ISSUES);
    expect(countProblems(issues)).toBe(MAX_CONFIG_ISSUES);
  });

  test('a long list of unknown keys names ten of them and counts the rest', () => {
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

  test('a few unknown keys keep zod words, every key named', () => {
    const issues = issuesOf(checked('zz1: 1\nzz2: 2\n').result);
    expect(issues[0]?.message).toBe('Unrecognized keys: "zz1", "zz2"');
    expect(issues[0]?.fix).toBe('remove "zz1", "zz2" — this file has no such setting');
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

  test('a list index is read as the library reads one: a whole number, or a string of one', () => {
    const read = readConfigText('l:\n  - a\n  - b\n');
    if (!read.ok) throw new Error('expected the text to read');
    expect(read.read.locate(['l', 1])).toEqual({ line: 3, column: 5 });
    expect(read.read.locate(['l', '1'])).toEqual({ line: 3, column: 5 });
    // Not an index: the list itself (its key).
    for (const part of ['x', -1, 1.5, '']) expect(read.read.locate(['l', part])).toEqual({ line: 1, column: 1 });
  });

  test('an alias is not followed: a path through one stops at it', () => {
    const read = readConfigText('a: &x\n  b: 1\nc: *x\n');
    if (!read.ok) throw new Error('expected the text to read');
    expect(read.read.locate(['c', 'b'])).toEqual({ line: 3, column: 1 });
  });
});

describe('a YAML 1.1 tag is not resolved inside the parse', () => {
  test.each([
    ['!!omap', 'a: !!omap [x: 1, y: 2]\n', { a: [{ x: 1 }, { y: 2 }] }],
    ['!!pairs', 'a: !!pairs [x: 1]\n', { a: [{ x: 1 }] }],
    ['!!set', 'a: !!set {x, y}\n', { a: { x: null, y: null } }],
    ['!!binary', 'a: !!binary aGVsbG8=\n', { a: 'aGVsbG8=' }],
    ['!!timestamp', 'a: !!timestamp 2020-01-01\n', { a: '2020-01-01' }],
  ])('%s reads as the plain value it is written as', (_tag, text, value) => {
    const read = readConfigText(text);
    if (!read.ok) throw new Error('expected the text to read');
    expect(read.read.value).toEqual(value);
  });

  test('the core tags still resolve', () => {
    const read = readConfigText('a: !!str 5\nb: !!int "5"\n');
    if (!read.ok) throw new Error('expected the text to read');
    expect(read.read.value).toEqual({ a: '5', b: 5 });
  });

  test('a !!omap of many short keys at the cap reads in under the bound (it took 7–10 s resolved)', () => {
    const text = `${filled(CONFIG_FILE_MAX_BYTES - 1, 'a: !!omap [', index => `${index.toString(36)}:,`)}]`;
    const started = performance.now();
    const read = readConfigText(text);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
    expect(read.ok).toBe(true);
  });
});

describe("the agent's door counts every problem and lists no more than the cap", () => {
  const loginsDef = defineConfig({
    collection: 'logins',
    name: /^[a-z0-9-]{1,40}$/,
    schema: z.strictObject({ env: z.record(z.string(), z.string()).optional() }),
    axis: 'configure',
    loosens: () => [],
  });

  function world() {
    const fs = createMemoryHostFs();
    const files = createConfigFiles({
      home: HOME,
      fs,
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [{ plugin: 'logins', def: loginsDef }],
    });
    const agent = agentConfig({
      writer: () => files.writer(),
      control: () => ({ allows: async () => true }),
      status: () => files.status(),
      home: HOME,
      binary: 'fy',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    return { fs, files, agent };
  }
  const standing = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
  const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);
  const wrong = (count: number): string =>
    `env:\n${Array.from({ length: count }, (_, index) => `  K${String(index)}: []\n`).join('')}`;

  test('T-0033 config_validate says how many problems there are, all of them, and lists the cap', async () => {
    const { agent } = world();
    const answer = await agent.run(
      call({ tool: 'config.validate', path: 'logins/a.yaml', text: wrong(120) }),
      standing,
    );
    expect(answer.summary).toBe('logins/a.yaml does not check: 120 problems. Fix each and validate again.');
    expect(answer.issues).toHaveLength(MAX_CONFIG_ISSUES + 1);
  });

  test('T-0034 config_write refuses with the same cap', async () => {
    const { agent } = world();
    const answer = await agent.run(call({ tool: 'config.write', path: 'logins/a.yaml', text: wrong(120) }), standing);
    expect(answer.issues).toHaveLength(MAX_CONFIG_ISSUES + 1);
    expect(countProblems(answer.issues ?? [])).toBe(120);
  });

  test('T-0032 the listing over many broken files lists the cap, counts every problem, and points at a file', async () => {
    const { fs, files, agent } = world();
    for (const name of ['a', 'b', 'c']) fs.seed(`${HOME}/config/logins/${name}.yaml`, wrong(70));
    await files.reload();
    // Each file read alone: its own cap.
    const one = await agent.run(call({ tool: 'config.read', path: 'logins/b.yaml' }), standing);
    expect(one.issues).toHaveLength(MAX_CONFIG_ISSUES + 1);
    const listing = await agent.run(call({ tool: 'config.read' }), standing);
    expect(listing.issues).toHaveLength(MAX_CONFIG_ISSUES + 1);
    expect(listing.summary).toContain('; 210 with errors;');
    expect(countProblems(listing.issues ?? [])).toBe(210);
    // The rest are counted at the first file left out, where config_read lists them.
    expect(listing.issues?.at(-1)?.path).toBe('logins/a.yaml');
  });
});
