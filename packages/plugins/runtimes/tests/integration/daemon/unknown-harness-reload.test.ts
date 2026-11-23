/**
 * A typo in a `harness:` word, through the kernel's REAL configuration service over a real disk (a temp directory standing
 * in for `$FY_HOME/config`): the file is read, edited, reloaded by the kernel and read again, with no login or file injected.
 *
 * The bug this pins (review of PR 2378): two valid runtimes, then `alpha.yaml` set to `harness: gemni` and reloaded. The
 * kernel's schema refused the word, logged the file with the generic enum error and KEPT THE LAST GOOD COPY, so alpha went
 * on launching on its old Claude key. A file with an unknown harness word now loads, and the one runtime (or component) it
 * names is set aside by name with the shared refusal sentence; everything else stays.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Log } from '@ferretry/kernel/contract';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../../core/kernel/host/state/host-fs.ts';
import {
  INSTRUCTION_ITEMS,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  type ProfileFile,
  type RuntimeFile,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
} from '../../../contract/index.ts';
import { ownInstructionsSource } from '../../../daemon/adapters/own-instructions-source.ts';
import { runtimesConfigFiles } from '../../../daemon/adapters/runtimes-config-files.ts';
import type { AccountModel } from '../../../daemon/lib/account/schema.ts';
import { createRuntimesApi } from '../../../daemon/lib/service/runtimes-api.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

const DEFS = [RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS, INSTRUCTION_ITEMS];

const TWO_RUNTIMES: Readonly<Record<string, string>> = {
  'runtimes/alpha.yaml': 'login: claude-you\nprofile: default\n',
  'runtimes/beta.yaml': 'login: claude-you\nprofile: default\n',
  'profiles/default.yaml': 'contents:\n  - modelSets/heavy\n',
  'model-sets/heavy.yaml': 'models:\n  - claude-opus-5-5\ndefault: claude-opus-5-5\n',
};

async function world(seed: Readonly<Record<string, string>>) {
  const home = await mkdtemp(join(tmpdir(), 'fy-unknown-harness-'));
  homes.push(home);
  const put = async (relative: string, text: string) => {
    await mkdir(dirname(join(home, 'config', relative)), { recursive: true });
    await writeFile(join(home, 'config', relative), text);
  };
  for (const [relative, text] of Object.entries(seed)) await put(relative, text);
  const files = createConfigFiles({
    home,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: silentLog,
    binary: 'fy',
    defs: DEFS.map(def => ({ plugin: 'runtimes', def: def as never })),
  });
  await files.reload();
  // A new instructions file is a loosening, held until the owner confirms it: it is written the way the app writes it.
  const writeInstructions = async (name: string, text: string) => {
    const written = await files.write('runtimes', INSTRUCTION_ITEMS as never, name, text, { confirmedLoosening: true });
    return written.kind;
  };
  return { put, reload: async () => await files.reload(), port: files.port('runtimes'), writeInstructions };
}

const adapter = (port: Awaited<ReturnType<typeof world>>['port']) =>
  runtimesConfigFiles({
    config: port,
    logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
    components: () => 'unavailable',
    within: work => work,
  });

const modelOf = (loaded: { evaluation: { effective: { model: AccountModel } } }) => loaded.evaluation.effective.model;

describe('a runtime file whose harness word is a typo, through the real reload', () => {
  const runtimesApi = (port: Awaited<ReturnType<typeof world>>['port']) =>
    createRuntimesApi({
      runtimes: () => port.collection(RUNTIME_ITEMS as never) as unknown as ReadonlyMap<string, RuntimeFile>,
      profiles: () => port.collection(PROFILE_ITEMS as never) as unknown as ReadonlyMap<string, ProfileFile>,
      defaultSetting: () => undefined,
      harnesses: () => ['claude-code', 'codex'],
      logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
      now: () => 1_000_000,
    });

  it('sets THAT runtime aside by file name and keeps the other, and no last-good copy of it stays launchable', async () => {
    const { port, put, reload } = await world(TWO_RUNTIMES);
    const before = await adapter(port).load();
    expect(Object.keys(modelOf(before).runtimes).toSorted()).toEqual(['alpha', 'beta']);
    expect((await runtimesApi(port).resolve('alpha' as never)).ok).toBe(true);

    await put('runtimes/alpha.yaml', 'login: claude-you\nprofile: default\nharness: gemni\n');
    await reload();

    // The kernel holds the file as written, not the copy from before the typo.
    expect((port.collection(RUNTIME_ITEMS as never) as ReadonlyMap<string, RuntimeFile>).get('alpha')?.harness).toBe(
      'gemni',
    );
    const after = await adapter(port).load();
    expect(Object.keys(modelOf(after).runtimes)).toEqual(['beta']);
    expect(after.notices).toContain(
      'config/runtimes/alpha.yaml: gemni is not supported here, so this runtime is not started',
    );
    // `runtime ls` / `runtime show` and a launch all refuse it with the shared sentence; the other still starts.
    const api = runtimesApi(port);
    const alpha = (await api.list()).find(summary => summary.id === 'alpha');
    expect(alpha?.launch).toEqual({ available: false, reason: 'gemni is not supported here' });
    expect((await api.get('alpha' as never))?.launch).toEqual({
      available: false,
      reason: 'gemni is not supported here',
    });
    const refused = await api.resolve('alpha' as never);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.sentence).toBe('config/runtimes/alpha.yaml: gemni is not supported here');
    expect((await api.resolve('beta' as never)).ok).toBe(true);
  });

  it('puts the runtime back the moment the word is corrected', async () => {
    const { port, put, reload } = await world(TWO_RUNTIMES);
    await put('runtimes/alpha.yaml', 'login: claude-you\nprofile: default\nharness: gemni\n');
    await reload();
    await put('runtimes/alpha.yaml', 'login: claude-you\nprofile: default\nharness: claude-code\n');
    await reload();

    expect(Object.keys(modelOf(await adapter(port).load()).runtimes).toSorted()).toEqual(['alpha', 'beta']);
    expect((await runtimesApi(port).resolve('alpha' as never)).ok).toBe(true);
  });
});

describe('a good component beside one whose harness word is a typo, through the real reload', () => {
  const profile = (...contents: string[]) =>
    `contents:\n  - modelSets/heavy\n${contents.map(c => `  - ${c}\n`).join('')}`;
  const seeded = async (profileText?: string) => {
    const rig = await world(
      profileText === undefined ? TWO_RUNTIMES : { ...TWO_RUNTIMES, 'profiles/default.yaml': profileText },
    );
    expect(await rig.writeInstructions('good', 'text: be kind\n')).toBe('applied');
    expect(await rig.writeInstructions('odd', 'text: be odd\nharness: gemni\n')).toBe('applied');
    return rig;
  };

  it('drops only the typo’d component, names it, and still reads the good one', async () => {
    const { port } = await seeded();
    const { readProfileComponents } = await import('../../../daemon/adapters/profile-components.ts');

    const reading = await readProfileComponents(
      () => 'unavailable',
      ownInstructionsSource(port),
      work => work,
    );

    expect(reading.instructions.state).toBe('read');
    if (reading.instructions.state !== 'read') return;
    expect([...reading.instructions.components.keys()]).toEqual(['good']);
    expect(reading.instructions.rejected?.get('odd')).toMatch(/gemni is not supported here/u);
  });

  it('does not block the fleet over a typo’d component no profile uses, and says which one was set aside', async () => {
    const { port } = await seeded(profile('instructions/good'));

    const loaded = await runtimesConfigFiles({
      config: port,
      logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
      components: () => 'unavailable',
      within: work => work,
    }).load();

    expect(loaded.unreadable).toEqual([]);
    expect(Object.keys(modelOf(loaded).components.instructions)).toContain('good');
    expect((loaded.notices ?? []).join('\n')).toMatch(/instructions component "odd".*gemni is not supported here/su);
  });

  it('names the typo’d component, and only it, when a profile does use it', async () => {
    const { port } = await seeded(profile('instructions/good', 'instructions/odd'));

    const loaded = await adapter(port).load();

    expect(loaded.unreadable).toHaveLength(1);
    expect(loaded.unreadable[0]).toMatch(/instructions component "odd".*gemni is not supported here/su);
  });
});
