/**
 * The SPEED half of `../../unit/host-config/issue-cap.test.ts`: the checks, the locate walk and the YAML 1.1 tag read,
 * each at the size limit, answer within one hard bound. The answers themselves (the cap on the issues) are unit's.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { checkConfigText } from '../../../host/config/check.ts';
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
function checkedMs(text: string): number {
  let ms = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3 && ms >= BOUND_MS; attempt += 1) {
    const started = performance.now();
    checkConfigText(envDef, 'voice.yaml', text, 'fy');
    ms = Math.min(ms, performance.now() - started);
  }
  return ms;
}

describe('one check at the size limit answers within the bound', () => {
  const cases: readonly (readonly [label: string, text: string])[] = [
    ['syntax errors', filled(CONFIG_FILE_MAX_BYTES, '', () => '"\n')],
    ['duplicate keys', filled(CONFIG_FILE_MAX_BYTES, '', () => 'env: {}\n')],
    ['raw secrets', filled(CONFIG_FILE_MAX_BYTES, 'env:\n', index => `  K${index.toString(36)}: ${KEYLIKE}\n`)],
    ['schema issues', filled(CONFIG_FILE_MAX_BYTES, 'env:\n', index => `  K${index.toString(36)}: []\n`)],
    ['unknown keys', filled(CONFIG_FILE_MAX_BYTES, '', index => `zz${index.toString(36)}: 1\n`)],
    ['a 250 KiB unknown key', `? ${'k'.repeat(250 * 1024)}\n: 1\n`],
  ];
  for (const [label, text] of cases) {
    test(`T-0033 ${label}: checked in under ${BOUND_MS} ms`, () => {
      expect(checkedMs(text)).toBeLessThan(BOUND_MS);
    });
  }
});

describe('locate walks a path one step per part', () => {
  test('20 000 entries of one mapping, each located, in under the bound', () => {
    const text = filled(CONFIG_FILE_MAX_BYTES, 'a:\n  b:\n', index => `    k${index.toString(36)}: x\n`);
    const read = readConfigText(text);
    if (!read.ok) throw new Error('expected the text to read');
    const entries = text.split('\n').length - 3;
    expect(entries).toBeGreaterThan(20_000);
    const started = performance.now();
    for (let index = 0; index < entries; index += 1) read.read.locate(['a', 'b', `k${index.toString(36)}`]);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
  });
});

describe('a YAML 1.1 tag is not resolved inside the parse', () => {
  test('a !!omap of many short keys at the cap reads in under the bound (it took 7–10 s resolved)', () => {
    const text = `${filled(CONFIG_FILE_MAX_BYTES - 1, 'a: !!omap [', index => `${index.toString(36)}:,`)}]`;
    const started = performance.now();
    readConfigText(text);
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
  });
});
