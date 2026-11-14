import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert } from '../../src/convert.ts';
import { LEFT_BEHIND } from '../../src/left-behind.ts';
import { summarise } from '../../src/report.ts';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

/**
 * Owner ruling !A516 ("Leave them"): six things are NOT carried to v5. The migration prompt (before the owner confirms)
 * and the final report must say so in short plain lines, and say where v4's home stays. Text and report only: the
 * converter carries nothing new. Fake homes only.
 */
const SIX = [
  'chat history',
  'browser sign-ins',
  'named agent terminals',
  'Warden machine agenda item',
  'default routing prompt before your own routing words',
  'Gate kept-bucket and grant audit history',
] as const;
const lacks = (text: string, needle: string): boolean => !text.toLowerCase().includes(needle.toLowerCase());
// "kept-bucket" is the Gate's own term for an audit store, not a claim.
const CLAIMS_CARRIED = /\b(carried over|converted|moved|kept(?!-bucket))\b/i;

describe('the shared list', () => {
  test('names exactly the six owner-ruled items, in plain words', () => {
    expect(LEFT_BEHIND).toHaveLength(6);
    for (const needle of SIX)
      expect(LEFT_BEHIND.some(line => line.toLowerCase().includes(needle.toLowerCase()))).toBe(true);
  });

  test('no item claims it was carried', () => {
    for (const line of LEFT_BEHIND) expect(line).not.toMatch(CLAIMS_CARRIED);
  });
});

describe('the converter report', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-leftbehind-'));
    await mkdir(join(root, 'v4', 'state', 'sessions'), { recursive: true });
    await writeFile(join(root, 'v4', 'layout-version'), '2\n', { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the printed summary and the written JSON both list every left-behind item and the v4 path', async () => {
    const from = join(root, 'v4');
    const result = await convert({
      from,
      to: join(root, 'v5'),
      dryRun: false,
      lock: { held: async () => false },
      now: () => new Date('2026-11-14T01:00:00.000Z'),
    });
    if (result.kind !== 'done') throw new Error('expected done');
    const printed = summarise(result.report);
    for (const needle of SIX) expect(printed).toContain(needle);
    expect(printed).toContain(`kept untouched at ${from}`);
    expect(printed).toContain('FY_HOME=<copy>');
    expect(result.report.leftBehind).toEqual([...LEFT_BEHIND]);
    // Every left-behind line is a "-" item; none of them says it was carried.
    const items = printed.split('\n').filter(line => line.startsWith('  - '));
    expect(items).toHaveLength(6);
    for (const line of items) expect(line).not.toMatch(CLAIMS_CARRIED);
  });

  test('the FULL summary, with the real steps, never says an excluded item was converted', async () => {
    const result = await convert({
      from: join(root, 'v4'),
      to: join(root, 'v5'),
      dryRun: false,
      lock: { held: async () => false },
      now: () => new Date('2026-11-14T01:00:00.000Z'),
    });
    if (result.kind !== 'done') throw new Error('expected done');
    const printed = summarise(result.report);
    const lines = printed.split('\n');
    const stepLine = (id: string): string => {
      const step = result.report.steps.find(item => item.id === id);
      if (step === undefined) throw new Error(`no step ${id}`);
      const line = lines.find(item => item.includes(step.title));
      if (line === undefined) throw new Error(`no summary line for ${id}`);
      return line;
    };
    // Chat history: the harness folders are opaque files, never "conversations, for resume".
    expect(stepLine('harness-homes')).toContain('chat history is left behind');
    expect(stepLine('harness-homes')).toContain('NOT usable in v5');
    expect(printed).not.toMatch(/conversations, for resume/i);
    // Security history: the Gate and Access lines name what is left out.
    expect(stepLine('gate')).toContain('kept-bucket history is left behind');
    expect(stepLine('access')).toContain('grant audit history is left behind');
    // The JSON says it too, in each step's own not-carried list.
    const notCarried = (id: string): string =>
      (result.report.steps.find(step => step.id === id)?.notCarried ?? []).map(item => item.what).join(' | ');
    expect(notCarried('harness-homes')).toContain('chat history');
    expect(notCarried('gate')).toContain('kept-bucket audit history');
    expect(notCarried('access')).toContain('grant audit history');
  });

  test('a dry run says it too (the owner reads the dry run first)', async () => {
    const result = await convert({
      from: join(root, 'v4'),
      to: join(root, 'v5'),
      dryRun: true,
      lock: { held: async () => false },
      now: () => new Date('2026-11-14T01:00:00.000Z'),
    });
    if (result.kind !== 'done') throw new Error('expected done');
    for (const needle of SIX) expect(summarise(result.report)).toContain(needle);
  });
});

describe('the prompt document', () => {
  test('lists every left-behind item and claims no harness conversation or security history is carried', async () => {
    const doc = await readFile(
      join(import.meta.dir, '..', '..', '..', '..', 'docs', 'migration', 'v4-to-v5-prompt.md'),
      'utf8',
    );
    for (const line of LEFT_BEHIND) expect(doc).toContain(line);
    expect(doc).not.toMatch(/Harness conversations[^|]*\|\s*\*\*Kept\*\*/);
    expect(doc).not.toMatch(/Security log[^|]*\|\s*\*\*Kept\*\*/);
  });
});

describe('migrate.sh', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await makeSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });
  const backupPath = (): string => `${sb.v4home}-before-2026-11-13-1200`;

  const expectBlock = (text: string): void => {
    expect(text).toContain('Left behind');
    for (const line of LEFT_BEHIND) expect(text).toContain(`- ${line}`);
    expect(text).toContain(`kept untouched at ${backupPath()}`);
    expect(text).toContain('FY_HOME=<copy>');
    for (const line of text.split('\n').filter(l => l.startsWith('  - '))) expect(line).not.toMatch(CLAIMS_CARRIED);
  };

  test('preflight shows it before anything is stopped or moved', async () => {
    const result = await sb.run('preflight', ['--notes', sb.notes]);
    expect(result.code).toBe(0);
    expectBlock(result.out);
    expect(lacks(await sb.notesText(), '# backed-up')).toBe(true);
  });

  test('backup without the owner’s yes shows it again, with the path the backup will have', async () => {
    await advance(sb, 'quiet');
    const result = await sb.run('backup', []);
    expect(result.code).toBe(1);
    expectBlock(result.err);
  });

  test('verify closes the run with it', async () => {
    await advance(sb, 'verify');
    const again = await sb.run('verify', []);
    expectBlock(again.out);
  });

  test('the printed list is the converter’s list (one file, two readers)', async () => {
    const result = await sb.run('preflight', ['--notes', sb.notes]);
    const shown = result.out
      .split('\n')
      .filter(line => line.startsWith('  - '))
      .map(line => line.slice(4));
    expect(shown).toEqual([...LEFT_BEHIND]);
  });
});
