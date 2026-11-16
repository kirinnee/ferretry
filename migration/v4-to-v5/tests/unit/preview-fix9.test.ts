import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PREVIEW } from '../../preview/plan.ts';
import { ownerNote } from '../../preview/driver.ts';
import { terminalsFileState } from '../../preview/start-checks.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { buildPlan, settingsStep } from '../../src/steps/settings.ts';
import { previewShellEnv } from '../../src/v5/preview-env.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};

/** v4 holds `limits.yaml` and `machine.yaml` as written (accepted), the carried loosening included. */
const acceptedHome = async () => {
  const limits = 'enabled: true\n';
  const machine = 'timeZone: Europe/Berlin\n';
  await put('config/limits.yaml', limits);
  await put('config/machine.yaml', machine);
  await put(
    'state/config-accepted.json',
    JSON.stringify({
      'limits.yaml': { etag: sha256(limits), text: limits },
      'machine.yaml': { etag: sha256(machine), text: machine },
    }),
  );
};

/** A whole preview conversion (the plain pass included), restricted to the two steps these tests read. */
const run = async (owner: boolean) => {
  await put('layout-version', '2\n');
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    steps: [settingsStep, acceptedConfigStep],
    preview: true,
    previewV4Home: f.from,
    previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
    ...(owner ? { previewOwner: true } : {}),
  });
  expect(result.kind).toBe('done');
};

const record = (name: string) =>
  readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName(name)}.json`), 'utf8').then(
    text => JSON.parse(text) as { text: string; plugin: string },
    () => undefined,
  );

test('Minor-1 no flag, v4 limits enabled: true in effect: no record for limits.yaml (the preview forced it off)', async () => {
  await acceptedHome();
  await run(false);
  expect(await record('limits.yaml')).toBeUndefined();
  expect(await record('terminals.yaml')).toBeUndefined();
  expect(await record('claude-code/settings/fy-preview.yaml')).toBeUndefined();
  // The text the preview wrote is not v4's.
  expect(await readFile(join(f.to, 'config/limits.yaml'), 'utf8')).toContain('enabled: false');
});

test('Minor-1 no flag, an empty v4 home: no record for limits.yaml or any preview file', async () => {
  await run(false);
  for (const name of ['limits.yaml', 'terminals.yaml', 'claude-code/settings/fy-preview.yaml'])
    expect(await record(name)).toBeUndefined();
});

test('Minor-1 with --owner the forced limits.yaml and the other preview files are recorded', async () => {
  await acceptedHome();
  await run(true);
  const limits = await record('limits.yaml');
  expect(limits?.plugin).toBe('ferrets');
  expect(limits?.text).toBe(await readFile(join(f.to, 'config/limits.yaml'), 'utf8'));
  expect((await record('terminals.yaml'))?.plugin).toBe('terminals');
  expect((await record('claude-code/settings/fy-preview.yaml'))?.plugin).toBe('claude-code');
});

test('Minor-1 a carried v4 file the preview did not change keeps its carried record without the flag', async () => {
  await acceptedHome();
  await run(false);
  const usage = await record('usage.yaml');
  expect(usage?.plugin).toBe('usage');
  expect(usage?.text).toBe(await readFile(join(f.to, 'config/usage.yaml'), 'utf8'));
});

test('Minor-1 the Codex fy-preview item exists only in the preview conversion, so it is preview-authored', async () => {
  const env = previewShellEnv(f.to, PREVIEW.port);
  const base = { ...f.ctx(true) };
  const plain = await buildPlan(base, true);
  const preview = await buildPlan({ ...base, preview: true, previewShellEnv: env }, true);
  const codex = join('config', 'codex', 'settings', 'fy-preview.yaml');
  expect(plain.files.has(codex)).toBe(false);
  expect(preview.files.has(codex)).toBe(true);
});

test('Minor-1 mutation guard: with no plain comparison available every preview file counts as authored', async () => {
  await acceptedHome();
  const plain = f.ctx(true);
  await settingsStep.run(plain);
  const ctx = {
    ...f.ctx(),
    preview: true,
    previewV4Home: f.from,
    previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
  };
  await settingsStep.run(ctx);
  await acceptedConfigStep.run(ctx);
  // Nothing recorded: no plain map, so even the unchanged usage.yaml counts as the preview's.
  expect(await record('usage.yaml')).toBeUndefined();
  expect(await record('limits.yaml')).toBeUndefined();
});

test('Minor-2 no sentence names an app Confirm or a config confirm verb; the remedy is clean then prepare --owner', async () => {
  const held = await terminalsFileState(f.to, async () => undefined);
  const sentences = [ownerNote(false), ownerNote(true), held.state === 'ok' ? '' : held.sentence];
  const heldRecord = await terminalsFileState(f.to, async path =>
    path.endsWith('terminals.yaml') ? 'environment:\n  A: "1"\n' : undefined,
  );
  if (heldRecord.state !== 'ok') sentences.push(heldRecord.sentence);
  for (const sentence of sentences) {
    expect(sentence).not.toContain('Confirm');
    expect(sentence).not.toContain('config confirm');
  }
  expect(ownerNote(false)).toContain('preview.sh clean');
  expect(ownerNote(false)).toContain('preview.sh prepare --owner');
});

test('Nit a file the preview wrote says so in its header, not "Carried from v4"', async () => {
  await run(false);
  const limits = await readFile(join(f.to, 'config/limits.yaml'), 'utf8');
  expect(limits).toContain('Written by the 5.0 preview (not carried from v4)');
  expect(limits).not.toContain('Carried from v4');
  const terminals = await readFile(join(f.to, 'config/terminals.yaml'), 'utf8');
  expect(terminals).not.toContain('Carried from v4');
});
