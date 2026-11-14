import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PacksFileSchema } from '@ferretry/plugin-packs/contract';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { packsStep } from '../../src/steps/packs.ts';
import { fixture } from './ferret-fixture.ts';

/**
 * The owner list once said "multi-line routing prompts beyond their last line" were left behind. A fake multi-line
 * models-guide prompt, run through the real Packs step, is the evidence for what is true: it is carried whole.
 */
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const PROMPT = [
  'Pick the model by the job.',
  'Planning and hard debugging: claude-opus-5-5 at max.',
  '',
  'Reviews: the strongest reviewer you have.',
  'Chores: the cheapest model, low effort.',
].join('\n');

test('a multi-line models-guide prompt is carried whole, every line, in order', async () => {
  await mkdir(join(f.from, 'config'), { recursive: true, mode: 0o700 });
  const indented = PROMPT.split('\n')
    .map(line => (line === '' ? '' : `  ${line}`))
    .join('\n');
  await writeFile(join(f.from, 'config/models-guide.yaml'), `prompt: |\n${indented}\n`, { mode: 0o600 });
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const written = PacksFileSchema.parse(parse(await readFile(join(f.to, 'config/packs.yaml'), 'utf8')));
  expect(written.routing?.prompt?.trimEnd()).toBe(PROMPT);
  expect(report.kept).toContainEqual({ what: 'routing prompt (from models-guide.yaml)', count: 1 });
});
