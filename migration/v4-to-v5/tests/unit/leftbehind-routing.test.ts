import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PacksFileSchema } from '@ferretry/plugin-packs/contract';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { packsStep } from '../../src/steps/packs.ts';
import { fixture } from './ferret-fixture.ts';

/**
 * What is really left behind of the routing prompt, from fake homes built in v4's shapes (4.291.x
 * `lib/pack/migrate.ts` and `routing.ts`). A prompt the guide already holds is carried whole. A home with NO prompt of
 * its own (the real shape: the old guide named no use cases, the prose and a preferences line were all it had) had the
 * DEFAULT prompt, rendered from v4's model catalogs, put in front of that prose by v4. That head is in no file, the
 * converter reads no catalogs, so it is the part that is not carried, and the report must say so.
 */
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(join(f.from, path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, path), text, { mode: 0o600 });
};
const packs = async () => PacksFileSchema.parse(parse(await readFile(join(f.to, 'config/packs.yaml'), 'utf8')));

const PROMPT = [
  'Pick the model by the job.',
  'Planning and hard debugging: claude-opus-5-5 at max.',
  '',
  'Reviews: the strongest reviewer you have.',
  'Chores: the cheapest model, low effort.',
].join('\n');

test('a multi-line prompt the guide already holds is carried whole, every line, in order', async () => {
  const indented = PROMPT.split('\n')
    .map(line => (line === '' ? '' : `  ${line}`))
    .join('\n');
  await write('config/models-guide.yaml', `prompt: |\n${indented}\n`);
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await packs()).routing?.prompt?.trimEnd()).toBe(PROMPT);
  expect(report.kept).toContainEqual({ what: 'routing prompt (from models-guide.yaml)', count: 1 });
  expect(report.notCarried.some(item => item.what.includes('default routing prompt'))).toBe(false);
});

test('an old guide with no use cases: only the owner’s own words are carried, and the report says the default head is not', async () => {
  await write(
    'config/models-guide.yaml',
    `routing:\n  prompt: |\n    Use the big model for hard problems.\n    Use the small one for chores.\n`,
  );
  await write('config/pack.yaml', 'routingPreferences: FAKE-PREFERENCE-TEXT\n');
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  // What is written: the prose and the preferences line, with no tier lines in front.
  expect((await packs()).routing?.prompt?.trimEnd()).toBe(
    'Use the big model for hard problems.\nUse the small one for chores.\nPreferences: FAKE-PREFERENCE-TEXT',
  );
  // What the report says: not "routing prompt kept", but exactly what was kept and what was left out.
  const kept = report.kept.map(item => item.what);
  expect(kept).toContain(
    'your own routing words only (the default routing prompt v4 rendered in front of them is NOT carried)',
  );
  expect(kept).not.toContain('routing prompt (from models-guide.yaml)');
  const lost = report.notCarried.find(item => item.what.includes('default routing prompt v4 rendered'));
  expect(lost?.why).toContain('model catalogs');
  expect(report.note).toContain('carried alone');
  expect(JSON.stringify(report)).toContain('NOT carried');
});

test('an old guide WITH use cases keeps the head v4 rendered from them, so nothing is reported as left out', async () => {
  await write(
    'config/models-guide.yaml',
    'useCases:\n  - title: Reviews\n    candidates:\n      - model: claude-opus-5-5\n        effort: high\n',
  );
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await packs()).routing?.prompt).toContain('- Reviews: claude-opus-5-5 at high.');
  expect(report.notCarried.some(item => item.what.includes('default routing prompt'))).toBe(false);
});
