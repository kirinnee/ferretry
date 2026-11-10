/**
 * The testing host's `kernel.processes` stays in step with the real host's: the same rule (`host/processes.ts`)
 * decides both, over the same process table, so a plugin's unit test hears the pids, the refusals and the signal
 * outcomes production gives. The real host is booted for real (its own roots on the disk, its own-root check); only
 * the process table is the test's, on both sides.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { KernelPorts, OwnFolder, RootHandle } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { type TestProcess, type TestProcessTable, testHost, testProcessTable } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const SECRET = 'sk-live-planted-secret-value';

/** What a host hands the halves under test: Runtimes (declared, with the fleet root) and a plugin that declares nothing. */
interface Seen {
  runtimes?: KernelPorts;
  stranger?: KernelPorts;
  borrower?: KernelPorts;
}

const halves = (seen: Seen) => [
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtimes',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['fleet', 'harness-home'], processes: { environment: ['CODEX_HOME'] } },
    }),
    {
      build: ({ kernel }) => {
        seen.runtimes = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'borrower',
      title: 'Borrower',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { processes: { environment: ['CODEX_HOME'] } },
    }),
    {
      build: ({ kernel }) => {
        seen.borrower = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'stranger',
      title: 'Stranger',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: {},
    }),
    {
      build: ({ kernel }) => {
        seen.stranger = kernel;
        return {};
      },
    },
  ),
];

/** The world every case runs in, spelled with the host's own path of the Codex home. */
function world(home: string) {
  const packages = `${home}/packages/app-server-daemon`;
  const processes: readonly TestProcess[] = [
    {
      pid: 4242,
      commandLine: `${packages}/bin/codex app-server`,
      environment: { CODEX_HOME: home, OPENAI_API_KEY: SECRET },
    },
    { pid: 4243, commandLine: `${packages}/bin/codex updater`, environment: { CODEX_HOME: home } },
    { pid: 4300, commandLine: 'codex --tui', environment: { CODEX_HOME: home } },
    { pid: 4400, uid: 0, commandLine: `${packages}/bin/codex app-server`, environment: { CODEX_HOME: home } },
    { pid: 4500, commandLine: '/usr/bin/vim notes.txt' },
    { pid: 1000, commandLine: `${packages}/bin/codex app-server` },
  ];
  return testProcessTable({ processes, self: 1000, ancestors: [999] });
}

type Answer = { readonly ok: unknown } | { readonly refused: string };
const answer = async (call: () => Promise<unknown>): Promise<Answer> => {
  try {
    return { ok: await call() };
  } catch (error) {
    return { refused: (error as Error).message };
  }
};

/** The eight-plus cases, run against one host's ports. */
async function cases(
  seen: Seen,
  table: TestProcessTable,
  ownerDir: string,
): Promise<readonly (readonly [string, Answer])[]> {
  const runtimes = seen.runtimes as KernelPorts;
  const stranger = seen.stranger as KernelPorts;
  const borrower = seen.borrower as KernelPorts;
  const fleet = runtimes.roots.root('fleet');
  const at = (root: RootHandle, path: string): FencedPath => {
    const resolved = root.resolve(path);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  };
  await fleet.makeDirectory(at(fleet, 'homes/codex-a/packages/app-server-daemon/bin'));
  await fleet.writeText(at(fleet, 'homes/codex-a/packages/app-server-daemon/bin/codex'), '#!/bin/sh\n');
  const home: OwnFolder = { root: fleet, path: at(fleet, 'homes/codex-a') };
  const packages: OwnFolder = { root: fleet, path: at(fleet, 'homes/codex-a/packages/app-server-daemon') };
  const forged: OwnFolder = { root: { ...fleet }, path: home.path };
  const owner = runtimes.roots.root('harness-home', { subfolder: ownerDir });
  const ownerFolder: OwnFolder = { root: owner, path: at(owner, 'x') };
  await fleet.makeDirectory(at(fleet, 'bin'));
  const outsideHomes: OwnFolder = { root: fleet, path: at(fleet, 'bin') };
  const homesItself: OwnFolder = { root: fleet, path: at(fleet, 'homes') };
  // BG-008: a handle SCOPED to one home answers as an unscoped handle does for the same folder
  await fleet.writeText(at(fleet, 'bin/tools/x.txt'), 'x');
  const scopedHome = runtimes.roots.root('fleet', { subfolder: 'homes/codex-a' });
  const scopedPackages: OwnFolder = { root: scopedHome, path: at(scopedHome, 'packages/app-server-daemon') };
  const scopedBin = runtimes.roots.root('fleet', { subfolder: 'bin' });
  const scopedOutside: OwnFolder = { root: scopedBin, path: at(scopedBin, 'tools') };
  const p = runtimes.processes;
  const out: (readonly [string, Answer])[] = [
    ['usersOf a scoped fleet home folder', await answer(() => p.usersOf('CODEX_HOME', scopedPackages))],
    ['usersOf a scoped fleet folder outside homes', await answer(() => p.usersOf('CODEX_HOME', scopedOutside))],
    ['runsFrom the daemon through a scoped fleet handle', await answer(() => p.runsFrom(4242, scopedPackages))],
    ['runsFrom through a scope outside homes', await answer(() => p.runsFrom(4242, scopedOutside))],
    ['usersOf exact', await answer(() => p.usersOf('CODEX_HOME', home))],
    ['usersOf undeclared variable', await answer(() => p.usersOf('OPENAI_API_KEY', home))],
    ['usersOf a forged handle', await answer(() => p.usersOf('CODEX_HOME', forged))],
    ['usersOf an owner-root folder', await answer(() => p.usersOf('CODEX_HOME', ownerFolder))],
    ['usersOf a fleet folder outside homes', await answer(() => p.usersOf('CODEX_HOME', outsideHomes))],
    ['usersOf homes itself', await answer(() => p.usersOf('CODEX_HOME', homesItself))],
    ['runsFrom the daemon', await answer(() => p.runsFrom(4242, packages))],
    ['runsFrom the TUI', await answer(() => p.runsFrom(4300, packages))],
    ['runsFrom another uid', await answer(() => p.runsFrom(4400, packages))],
    ['terminate a reused pid', await answer(() => p.terminate(4500, packages))],
    ['terminate the daemon itself', await answer(() => p.terminate(1000, packages))],
    ['terminate pid 1', await answer(() => p.terminate(1, packages))],
    ['terminate the app server', await answer(() => p.terminate(4242, packages))],
    ['terminate it again', await answer(() => p.terminate(4242, packages))],
    ['usersOf after the signal', await answer(() => p.usersOf('CODEX_HOME', home))],
    ['an undeclared plugin', await answer(() => stranger.processes.usersOf('CODEX_HOME', home))],
    ['a declared plugin with runtimes’ handle', await answer(() => borrower.processes.terminate(4243, packages))],
    ['signals', { ok: [...table.signals] }],
  ];
  return out;
}

async function onTestingHost() {
  const seen: Seen = {};
  const table = world('/fleet/homes/codex-a');
  const host = await testHost({ plugins: halves(seen), processes: table });
  try {
    return await cases(seen, table, '/home/owner/.x');
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-processes-parity-`));
  await mkdir(`${parent}/owner`);
  parents.push(parent);
  const home = `${parent}/home`;
  const table = world(`${home}/fleet/homes/codex-a`);
  const seen: Seen = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      processTable: table,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    return await cases(seen, table, `${parent}/owner`);
  } finally {
    await outcome.host.stop();
  }
}

test('processes parity: the real host and the testing host answer every case alike', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing).toEqual(real);
  // and what both answer is the rule (so parity is not two hosts agreeing on a wrong answer)
  const byCase = Object.fromEntries(real);
  expect(byCase['usersOf exact']).toEqual({ ok: [4242, 4243, 4300] });
  expect(byCase['usersOf undeclared variable']).toEqual({
    refused: 'runtimes may match only the environment variables its permissions.processes lists, and not this one.',
  });
  expect(byCase['usersOf a forged handle']).toEqual({
    refused: 'runtimes may ask about processes only with a folder of one of its own roots.',
  });
  const notOwn = { refused: 'runtimes may ask about processes only with a folder of one of its own roots.' };
  expect(byCase['usersOf an owner-root folder']).toEqual(notOwn);
  const notHomes = { refused: 'kernel.processes accepts only a folder at or under fleet/homes/<id>' };
  expect(byCase['usersOf a fleet folder outside homes']).toEqual(notHomes);
  expect(byCase['usersOf homes itself']).toEqual(notHomes);
  // BG-008: a scope at (or below) one home is judged against the unscoped root; a scope outside homes/<id> still refuses
  expect(byCase['usersOf a scoped fleet home folder']).toEqual({ ok: [] });
  expect(byCase['usersOf a scoped fleet folder outside homes']).toEqual(notHomes);
  expect(byCase['runsFrom the daemon through a scoped fleet handle']).toEqual({ ok: true });
  expect(byCase['runsFrom through a scope outside homes']).toEqual(notHomes);
  expect(byCase['runsFrom the daemon']).toEqual({ ok: true });
  expect(byCase['runsFrom the TUI']).toEqual({ ok: false });
  expect(byCase['runsFrom another uid']).toEqual({ ok: false });
  expect(byCase['terminate a reused pid']).toEqual({ ok: 'refused' });
  expect(byCase['terminate the daemon itself']).toEqual({ ok: 'refused' });
  expect(byCase['terminate pid 1']).toEqual({ ok: 'refused' });
  expect(byCase['terminate the app server']).toEqual({ ok: 'signalled' });
  expect(byCase['terminate it again']).toEqual({ ok: 'gone' });
  expect(byCase['usersOf after the signal']).toEqual({ ok: [4243, 4300] });
  expect(byCase['an undeclared plugin']).toEqual({
    refused: 'stranger did not declare permissions.processes, so it asks about no process.',
  });
  expect(byCase['a declared plugin with runtimes’ handle']).toEqual({
    refused: 'borrower may ask about processes only with a folder of one of its own roots.',
  });
  expect(byCase.signals).toEqual({ ok: [{ pid: 4242, signal: 'SIGTERM' }] });
  expect(JSON.stringify(real)).not.toContain(SECRET);
});
