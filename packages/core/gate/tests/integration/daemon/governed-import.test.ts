/**
 * C59 O5-10b: a REMOTE, unlocked phone imports Claude Code, through the REAL Runtimes and Claude Code daemon halves over
 * the kernel's config service, judged by Gate's REAL loosening judge (temp FY_HOME, fake person home, no network).
 *
 * An import loosens on a fresh machine (a new instructions item is held for anyone but the owner at the machine), and
 * an unlock is never a fresh passkey proof. Before the fix the apply wrote the login and Claude Code's settings, then
 * Runtimes' set was HELD and thrown: a 409 after a partial write, and no log line. Now the import is ONE act: without a
 * fresh proof it is answered `403 grant_step_up_required` (`loosen-config`) before anything is written, the carrier asks
 * for the passkey and sends the same apply again, and the one proof covers every file of the import.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiRequest, CallStanding, ConfigWriteJudgement } from '@ferretry/kernel/contract';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { FakeFerrets } from '../../../../ferrets/contract/testing/index.ts';
import { nodeFs } from '../../../../kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../kernel/host/roots.ts';
import { daemonImplementations } from '../../../../kernel/src/generated/plugins.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import {
  fakeLoginChanges,
  fakeLoginEnvImport,
  fakeLogins,
} from '../../../../../plugins/logins/contract/testing/index.ts';
import { deviceStanding, StandInAdmission } from '../../../contract/testing/index.ts';
import { judgeLooseningWrite } from '../../../daemon/lib/policy/config-judge.ts';

const made: string[] = [];
afterEach(async () => {
  for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true });
});

/** A half as the generated registry builds it (another package's half is reached only through the registry). */
const half = (id: string): DaemonImplementation<any> => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

/**
 * A temp FY_HOME and a fake person's home, with the kernel's REAL roots over them (`fleet`, `harness-home`), so the
 * Runtimes half writes and reads real folders as production does. Nothing here reads a real home.
 */
async function fleetWorld() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fy-governed-import-')));
  made.push(parent);
  const home = join(parent, 'fy-home');
  const person = join(parent, 'person');
  await mkdir(join(home, 'fleet'), { recursive: true });
  await mkdir(join(person, '.claude', 'skills'), { recursive: true });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'runtimes', worktrees: join(parent, 'worktrees') },
    ['fleet', 'harness-home'],
    () => undefined,
    { harnessFiles: ['.claude.json'], setMode: true },
  );
  return { person, roots };
}

/** The owner's own Claude settings, with the permission mode the owner really runs. Fixture values only. */
const OWNER_SETTINGS = JSON.stringify({
  model: 'claude-opus-5-5',
  permissions: { defaultMode: 'bypassPermissions' },
  skipDangerousModePermissionPrompt: true,
});

/**
 * A paired phone, unlocked, holding every grant. `proofs` is how many fresh passkey proofs exist; each admission
 * mints its own claim function (as Gate's does) and a proof is taken atomically by whichever claim comes first.
 */
function phone() {
  const proof = { fresh: 0, taken: 0 };
  const standing = (_request: ApiRequest): CallStanding => ({
    ...deviceStanding('phone'),
    governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
    claimFreshStepUp: (() => {
      if (proof.fresh === 0) return false;
      proof.fresh -= 1;
      proof.taken += 1;
      return true;
    }) as CallStanding['claimFreshStepUp'],
  });
  return { proof, standing };
}

async function machine(): Promise<{ host: TestHost; proof: { fresh: number; taken: number }; asked: string[] }> {
  const world = await fleetWorld();
  const person = world.person;
  await writeFile(join(person, '.claude', 'CLAUDE.md'), 'Be kind to Claude.\n');
  await writeFile(join(person, '.claude', 'settings.json'), OWNER_SETTINGS);
  const runtimes = half('runtimes');
  const build = runtimes.build;
  if (build === undefined) throw new Error('the runtimes half has no build');
  // The registry's Runtimes half over the real roots of this world (the test host's own are in memory).
  const overRealRoots = {
    ...runtimes,
    build: (ctx: Parameters<typeof build>[0]) =>
      build({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never),
  } as DaemonImplementation<any>;
  const { proof, standing } = phone();
  const asked: string[] = [];
  const gate = Object.assign(new StandInAdmission(standing), {
    // Gate's REAL judge of a plugin's own loosening write (`GateAdmission.judgeConfigWrite` for a non-secret write).
    judgeConfigWrite: (input: ConfigWriteJudgement) => {
      const verdict = judgeLooseningWrite(input);
      asked.push(`${input.path} ${verdict}`);
      return verdict;
    },
  });
  const host = await testHost({
    plugins: [overRealRoots, half('claude-code')],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins([]),
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    gate,
    config: {},
    ownerHome: person,
    executables: ['/fixture/bin/claude'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
  return { host, proof, asked };
}

const stage = async (host: TestHost): Promise<string> => {
  const staged = await host.request('POST', '/v1/runtimes/proposals', {
    body: { change: { kind: 'setup.import', include: ['claude-code'] } },
  });
  expect([staged.status, staged.status === 200 ? '' : staged.body]).toEqual([200, '']);
  return staged.json<{ id: string }>().id;
};

const written = (host: TestHost): string[] => host.configChanges.map(change => change.path).toSorted();

const notApplied = (host: TestHost) =>
  host.logs.filter(line => line.level === 'warn' && line.message === 'runtimes: a change was not fully applied');

describe('C59 O5-10b a remote device imports Claude Code as ONE act on one passkey', () => {
  test('without a fresh proof: 403 loosen-config BEFORE anything is written, the change stays pending, and a log line says so', async () => {
    const { host, proof } = await machine();
    const id = await stage(host);

    const applied = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });

    expect(applied.status).toBe(403);
    expect(applied.json()).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure', act: 'loosen-config' },
    });
    // Nothing of the import landed: not the settings, not a held set.
    expect(written(host)).toEqual([]);
    expect(proof.taken).toBe(0);
    const pending = await host.request('GET', `/v1/runtimes/proposals/${id}`);
    expect(pending.json<{ state: string }>().state).toBe('pending');
    // Ids and codes only: the refusal's sentence never reaches the log.
    expect(notApplied(host).map(line => line.fields)).toEqual([
      { change: id, kind: 'setup.import', status: 403, code: 'grant_step_up_required', act: 'loosen-config' },
    ]);
  });

  test('the carrier proves the passkey and sends the same apply again: ONE proof covers settings, instructions, profile and runtime', async () => {
    const { host, proof, asked } = await machine();
    const id = await stage(host);
    expect((await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} })).status).toBe(403);

    proof.fresh = 1;
    const applied = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });

    expect([applied.status, applied.status === 200 ? '' : applied.body]).toEqual([200, '']);
    expect(applied.json()).toMatchObject({ outcome: 'executed', executor: 'setup' });
    expect(proof.taken).toBe(1);
    expect(written(host)).toEqual([
      'claude-code/settings/claude-settings.yaml',
      'instructions/claude-instructions.yaml',
      'model-sets/claude-models.yaml',
      'profiles/claude-default.yaml',
      'runtimes/claude-default.yaml',
    ]);
    // Every loosening the import asked about was put into effect on that one proof; nothing was held.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter(line => !line.endsWith(' apply'))).toEqual([]);
    // The first press's refusal is the only line: the applied import says nothing more.
    expect(notApplied(host)).toHaveLength(1);
  });
});
