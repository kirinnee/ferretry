/**
 * v5 HOLDS every add or change of `instructions/<n>.yaml` and `codex/hooks/<n>.yaml` until the owner confirms it (owner
 * ruling !A525 item 9). v4 never held either, so a converted machine must START with both in effect: the converter's
 * accepted-config step records them as accepted, and the kernel configuration service must then read them as `ok`, not
 * as held adds (a held add leaves the collection empty and the ferrets launch without the owner's instructions).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

const repo = join(import.meta.dir, '../../../..');
const { createConfigFiles } = await import(repo + '/packages/core/kernel/host/config/service.ts');
const { createNodeHostFs } = await import(repo + '/packages/core/kernel/host/state/host-fs.ts');
const { INSTRUCTION_ITEMS } = await import(repo + '/packages/plugins/runtimes/contract/index.ts');
const { CODEX_HOOKS } = await import(repo + '/packages/plugins/codex/contract/index.ts');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const v4 = async (path: string, text: string): Promise<void> => {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, text);
};

const HOOKS = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo started' }] }] } });

/** The kernel configuration service over the converted home, as the daemon boots it. */
async function reload() {
  const files = createConfigFiles({
    home: f.to,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined },
    log: quiet,
    binary: 'fy',
    defs: [
      { plugin: 'runtimes', def: INSTRUCTION_ITEMS },
      { plugin: 'codex', def: CODEX_HOOKS },
    ],
  });
  await files.reload();
  return files;
}

test('a converted instructions file and a converted codex hooks file are in effect, not held, right after conversion', async () => {
  await v4('config/components/instructions/main.yaml', 'file: instructions/main.md\nharness: claude\n');
  await v4('fleet/assets/instructions/main.md', '# House rules\nBe kind.\n');
  await v4('config/components/hooks/notes.yaml', 'harness: codex\nfile: components/hooks/notes.json\n');
  await v4('fleet/assets/components/hooks/notes.json', HOOKS);

  const ctx = f.ctx();
  expect((await settingsStep.run(ctx)).status).toBe('converted');
  const written = [...ctx.v5.writtenConfigs().keys()];
  expect(written).toContain('config/instructions/main.yaml');
  expect(written).toContain('config/codex/hooks/notes.yaml');

  // Before the accepted step the files are held adds: this is the state the conversion must never be left in.
  const before = await reload();
  expect(before.status().held.length).toBeGreaterThan(0);

  expect((await acceptedConfigStep.run(ctx)).status).toBe('converted');

  const files = await reload();
  const instructions = await files.read('runtimes', INSTRUCTION_ITEMS, 'main');
  const hooks = await files.read('codex', CODEX_HOOKS, 'notes');
  expect({ instructions: instructions?.state, hooks: hooks?.state }).toEqual({ instructions: 'ok', hooks: 'ok' });
  expect(files.status().held).toEqual([]);
});
