/**
 * MERGE BAR (docs/rebuild/merge-bar.md, "a converted home keeps its v4 spend caps"): a login v4 accepted WITH A BUDGET
 * whose file is now gone, and which a runtime still uses, is a deletion v4 HOLDS (`loginLoosening`: the budget would go
 * away). 5.0 must hold it too: the cap lives in usage.yaml now, so the login's own accepted record carries the budget as
 * the marker the Logins deletion judge reads. Without it the kernel drops the missing login on boot, the runtime that
 * uses it names an unknown credential, and the WHOLE runtime catalog becomes unreadable (`fleet_catalog_unreadable`).
 *
 * Real converter AND preview (owner / non-owner) -> the real kernel config service -> the real runtimes loader.
 * Fixtures and temp homes only; every number is synthetic.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { acceptedName } from '@ferretry/kernel/contract';
import { LOGINS_CONFIG } from '@ferretry/plugin-logins/contract';
import { USAGE_CONFIG } from '@ferretry/plugin-usage/contract';
import { createConfigFiles } from '../../../../packages/core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../packages/core/kernel/host/state/host-fs.ts';
import { fakeLogins, sampleLogin } from '../../../../packages/plugins/logins/contract/testing/index.ts';
import {
  INSTRUCTION_ITEMS,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
} from '../../../../packages/plugins/runtimes/contract/index.ts';
import { runtimesConfigFiles } from '../../../../packages/plugins/runtimes/daemon/adapters/runtimes-config-files.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { heldSection, prepare } from '../../preview/driver.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
};
const now = () => new Date('2026-11-09T00:00:00Z');
const lock = { held: async () => false };
const home = () => join(f.root, 'home');
const previewTarget = () => join(home(), '.ferretry-v5');
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};

type Mode = 'real' | 'preview' | 'preview-owner';
const MODES: readonly Mode[] = ['real', 'preview', 'preview-owner'];

async function convertHome(mode: Mode): Promise<{ readonly target: string; readonly report: string }> {
  if (mode === 'real') {
    const result = await convert({
      from: f.from,
      to: f.to,
      dryRun: false,
      lock,
      now,
      steps: [settingsStep, acceptedConfigStep],
    });
    if (result.kind !== 'done') throw new Error('the real conversion was refused');
    return { target: f.to, report: JSON.stringify(result.report) };
  }
  const done = await prepare({
    v4Home: f.from,
    target: previewTarget(),
    home: home(),
    owner: mode === 'preview-owner',
    lock,
    now,
  });
  expect(done.report?.complete).toBe(true);
  return { target: previewTarget(), report: `${JSON.stringify(done.report)}\n${heldSection(done.report as never)}` };
}

/** The converted home through the kernel's config service, with the logins and runtimes definitions registered. */
function service(target: string) {
  const defs = [
    { plugin: 'logins', def: LOGINS_CONFIG },
    { plugin: 'usage', def: USAGE_CONFIG },
    ...[RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS, INSTRUCTION_ITEMS].map(def => ({
      plugin: 'runtimes',
      def,
    })),
  ];
  return createConfigFiles({
    home: target,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: quiet,
    binary: 'fy',
    defs: defs as never,
    judge: () => false,
  });
}

/** v4: login `gone` accepted with a daily hard $10 and its file now removed; `work` is the only login on disk. */
async function arrangeDeletion(budget: string | null = '  daily:\n    hard: 10\n') {
  await put('layout-version', '2\n');
  const accepted = `harness: claude\nstore: host\n${budget === null ? '' : `budget:\n${budget}`}`;
  await f.put('state/config-accepted.json', { 'logins/gone.yaml': { etag: sha(accepted), text: accepted } });
  await put('config/logins/work.yaml', 'harness: claude\nstore: ferretry\n');
  await put('config/profiles/main.yaml', 'contents: []\n');
  await put('config/runtimes/good.yaml', 'credential: work\nprofile: main\n');
  await put('config/runtimes/affected.yaml', 'credential: gone\nprofile: main\n');
}

async function loadFleet(target: string) {
  const files = service(target);
  await files.reload();
  const logins = files.port('logins').collection(LOGINS_CONFIG as never) as {
    get(id: string): { store: string } | undefined;
  };
  const known = ['gone', 'work'].filter(id => logins.get(id) !== undefined);
  const loaded = await runtimesConfigFiles({
    config: files.port('runtimes'),
    logins: fakeLogins(
      known.map(id =>
        sampleLogin(id, { harness: 'claude-code', harnesses: ['claude-code'], store: logins.get(id)?.store } as never),
      ),
    ),
    components: () => 'unavailable',
    within: (work: unknown) => work,
  } as never).load();
  return { files, known, loaded };
}

describe('a v4-accepted login with a budget, its file gone and a runtime on it, stays a HELD deletion', () => {
  for (const mode of MODES)
    test(`${mode}: gone stays pending and effective, and the whole fleet loads with the unrelated runtime`, async () => {
      await arrangeDeletion();
      const { target, report } = await convertHome(mode);
      const { files, known, loaded } = await loadFleet(target);
      if (mode === 'real') {
        // The login deletion v4 holds is held here: the login is still in effect, awaiting the owner.
        expect(known).toEqual(['gone', 'work']);
        const held = files.held().find(edit => edit.plugin === 'logins');
        expect(held?.sentences.join(' ')).toContain('daily hard limit in dollars is removed (was 10)');
        expect(report).toContain('config/logins/gone.yaml (a held deletion)');
      } else {
        // The preview carries only signed-out shells: `gone` is held out with its runtime, never an all-shell hold.
        expect(known).toContain('work');
        expect(report).toContain('config/logins/gone.yaml (a held deletion)');
      }
      expect(loaded.unreadable).toEqual([]);
      expect(loaded.evaluation.effective.model.runtimes.good).toBeDefined();
    });

  test('real: the cap keeps ONE owner: the held deletion re-states the budget in the login record only as numbers, and usage.yaml still holds the cap', async () => {
    await arrangeDeletion('  daily:\n    hard: 10\n  weekly:\n    trigger: 40\n');
    const { target } = await convertHome('real');
    const dir = join(target, 'state/kernel/accepted-config');
    const record = JSON.parse(await readFile(join(dir, `${acceptedName('logins/gone.yaml')}.json`), 'utf8')) as {
      text: string;
    };
    expect(parse(record.text)).toEqual({
      harness: 'claude-code',
      store: 'host',
      budget: { daily: { hard: 10 }, weekly: { trigger: 40 } },
    });
    // The live usage.yaml has no cap for `gone` (its file is gone); the accepted one does, so the kernel holds its removal.
    const { files } = await loadFleet(target);
    expect(files.port('usage').file(USAGE_CONFIG)).toMatchObject({ budgets: { gone: { daily: { hard: 10 } } } });
  });

  test('real: a v4-accepted login WITHOUT a budget that is deleted is no hold: v4 applied it at once, and so does 5.0', async () => {
    await arrangeDeletion(null);
    const { target, report } = await convertHome('real');
    const files = service(target);
    await files.reload();
    expect(files.held().filter(edit => edit.plugin === 'logins')).toEqual([]);
    expect(report).not.toContain('config/logins/gone.yaml (a held deletion)');
    const record = await readFile(
      join(target, 'state/kernel/accepted-config', `${acceptedName('logins/gone.yaml')}.json`),
      'utf8',
    ).catch(() => '');
    expect(record).not.toContain('budget');
  });

  test('real: once the owner accepts the deletion the login is gone', async () => {
    await arrangeDeletion();
    const { target } = await convertHome('real');
    const files = service(target);
    await files.reload();
    const held = files.held().find(edit => edit.plugin === 'logins');
    expect(await files.confirm(held?.id ?? '')).toBe(true);
    await files.reload();
    const logins = files.port('logins').collection(LOGINS_CONFIG as never) as { get(id: string): unknown };
    expect(logins.get('gone')).toBeUndefined();
    expect(logins.get('work')).toBeDefined();
  });
});
