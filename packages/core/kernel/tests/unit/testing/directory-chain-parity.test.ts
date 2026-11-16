/**
 * The testing host's `RootHandle.checkPrivateChain` answers every case as the real host does: the same rule
 * (`chainFault` / `chainProblem` in `host/root-rules.ts`) decides both, so a plugin's unit test meets the refusals
 * production makes. The real host is booted for real (its roots on the disk, the chain the reviewer set to 0777); each
 * case is spelled with that host's own means (`chmod` on one, `setHomeFolder` / `setRootFolder` on the other).
 * A foreign owner is covered on each host by its own test (the real disk cannot `chown` without root).
 */
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { KernelPorts, RootHandle } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const PLUGIN = 'claude-code';
const BASE = `state/${PLUGIN}/agent-homes`;

interface Seen {
  claude?: KernelPorts;
  runtimes?: KernelPorts;
}

const halves = (seen: Seen) => [
  implementDaemon(
    definePlugin({
      id: PLUGIN,
      title: 'Claude',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['agent-homes', 'downloads'] },
    }),
    {
      build: ({ kernel }) => {
        seen.claude = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtimes',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['fleet', 'harness-home'] },
    }),
    {
      build: ({ kernel }) => {
        seen.runtimes = kernel;
        return {};
      },
    },
  ),
];

type Answer = { readonly safe: true } | { readonly fault: string; readonly component: string; readonly reason: string };

/** What each host does to make a folder unsafe, and to put it back. */
interface Places {
  readonly owner: string;
  /** `component` is relative to the home (`''` is the home). */
  readonly mode: (component: string, mode: number) => Promise<void>;
  readonly link: (on: boolean) => Promise<void>;
}

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

const ask = async (root: RootHandle, path: FencedPath): Promise<Answer> => {
  try {
    const verdict = await root.checkPrivateChain(path);
    return verdict.ok ? { safe: true } : { ...verdict.error };
  } catch (error) {
    return {
      fault: `threw ${(error as { refusal?: string }).refusal ?? (error as Error).message}`,
      component: '',
      reason: '',
    };
  }
};

async function cases(seen: Seen, places: Places): Promise<readonly (readonly [string, Answer])[]> {
  const claude = seen.claude as KernelPorts;
  const runtimes = seen.runtimes as KernelPorts;
  const homes = claude.roots.root('agent-homes', { subfolder: 'F1' });
  await homes.writeText(at(homes, 'settings.json'), '{}');
  const target = at(homes, '.');
  const missing = claude.roots.root('agent-homes', { subfolder: 'F2' });
  const rows: (readonly [string, Answer])[] = [];
  const note = async (title: string, root: RootHandle = homes, path: FencedPath = target): Promise<void> => {
    rows.push([title, await ask(root, path)]);
  };
  await note('a private chain passes');
  for (const [label, component] of [
    ['the home', ''],
    ['state', 'state'],
    ['the plugin folder', `state/${PLUGIN}`],
    ['agent-homes', BASE],
    ['the ferret folder', `${BASE}/F1`],
  ] as const) {
    await places.mode(component, 0o777);
    await note(`${label} at 0777`);
    await places.mode(component, 0o770);
    await note(`${label} at 0770 (group-writable)`);
    await places.mode(component, 0o703);
    await note(`${label} at 0703 (other-writable)`);
    await places.mode(component, 0o755);
    await note(`${label} at 0755 passes`);
    await places.mode(component, 0o700);
  }
  await note('and it passes again once put back');
  await note('the file under the folder is asked as its folder', homes, at(homes, 'settings.json'));
  await places.link(true);
  await note('the ferret folder is a link');
  await places.link(false);
  await note('and is a folder again');
  await note('a ferret folder that was never made', missing, at(missing, '.'));
  const harness = runtimes.roots.root('harness-home', { subfolder: places.owner });
  await note('an owner folder outside the home', harness, at(harness, '.'));
  const fleet = runtimes.roots.root('fleet');
  await fleet.writeText(at(fleet, 'homes/claude-a/settings.json'), '{}');
  await note('fleet below the home', fleet, at(fleet, 'homes/claude-a'));
  return rows;
}

async function onTestingHost() {
  const seen: Seen = {};
  const host = await testHost({
    plugins: halves(seen),
    fenceHome: '/home/owner/.test-home',
  });
  try {
    return await cases(seen, {
      owner: '/home/owner/sub',
      mode: async (component, mode) => {
        if (component.startsWith(`${BASE}/`))
          host.setRootFolder('agent-homes', component.slice(BASE.length + 1), { mode });
        else host.setHomeFolder(component, { mode });
      },
      link: async on => host.setRootFolder('agent-homes', 'F1', on ? { link: true } : {}),
    });
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/directory-chain-parity-`));
  parents.push(parent);
  const owner = `${parent}/owner`;
  const home = `${owner}/.test-home`;
  await mkdir(`${owner}/sub`, { recursive: true, mode: 0o700 });
  const seen: Seen = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const folder = `${home}/${BASE}/F1`;
    return await cases(seen, {
      owner: `${owner}/sub`,
      mode: async (component, mode) => await chmod(component === '' ? home : `${home}/${component}`, mode),
      link: async on => {
        if (on) {
          await rename(folder, `${folder}-real`);
          await symlink(`${folder}-real`, folder);
        } else {
          await rm(folder);
          await rename(`${folder}-real`, folder);
        }
      },
    });
  } finally {
    await outcome.host.stop();
  }
}

test('checkPrivateChain parity: the testing host answers every case as the real host does', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing.map(([title]) => title)).toEqual(real.map(([title]) => title));
  expect(Object.fromEntries(testing)).toEqual(Object.fromEntries(real));
  // and what both answer is the rule, not two hosts agreeing on a wrong answer
  const byCase = Object.fromEntries(real);
  expect(byCase['a private chain passes']).toEqual({ safe: true });
  expect(byCase['the home at 0777']).toMatchObject({ fault: 'writable_by_others', component: '.' });
  expect(byCase['state at 0777']).toMatchObject({ fault: 'writable_by_others', component: 'state' });
  expect(byCase['the plugin folder at 0777']).toMatchObject({
    fault: 'writable_by_others',
    component: `state/${PLUGIN}`,
  });
  expect(byCase['agent-homes at 0777']).toMatchObject({ fault: 'writable_by_others', component: BASE });
  expect(byCase['the ferret folder at 0777']).toMatchObject({ fault: 'writable_by_others', component: `${BASE}/F1` });
  expect(byCase['state at 0770 (group-writable)']).toMatchObject({ fault: 'writable_by_others' });
  expect(byCase['state at 0703 (other-writable)']).toMatchObject({ fault: 'writable_by_others' });
  expect(byCase['state at 0755 passes']).toEqual({ safe: true });
  expect(byCase['and it passes again once put back']).toEqual({ safe: true });
  expect(byCase['the ferret folder is a link']).toMatchObject({ fault: 'link', component: `${BASE}/F1` });
  expect(byCase['and is a folder again']).toEqual({ safe: true });
  expect(byCase['a ferret folder that was never made']).toMatchObject({ fault: 'missing', component: `${BASE}/F2` });
  expect(byCase['an owner folder outside the home']).toMatchObject({ fault: 'outside_home' });
  expect(byCase['fleet below the home']).toEqual({ safe: true });
});

test('checkPrivateChain (testing host): a foreign owner and an unknown daemon user refuse', async () => {
  const seen: Seen = {};
  const host = await testHost({ plugins: halves(seen), fenceHome: '/home/owner/.test-home' });
  try {
    const homes = (seen.claude as KernelPorts).roots.root('agent-homes', { subfolder: 'F1' });
    await homes.writeText(at(homes, 'settings.json'), '{}');
    host.setHomeFolder(`state/${PLUGIN}`, { owner: 4242 });
    expect(await ask(homes, at(homes, '.'))).toMatchObject({ fault: 'foreign_owner', component: `state/${PLUGIN}` });
  } finally {
    await host.stop();
  }
  const unknown = await testHost({ plugins: halves(seen), fenceHome: '/home/owner/.test-home', daemonUid: null });
  try {
    const homes = (seen.claude as KernelPorts).roots.root('agent-homes', { subfolder: 'F1' });
    await homes.writeText(at(homes, 'settings.json'), '{}');
    expect(await ask(homes, at(homes, '.'))).toMatchObject({ fault: 'unknown_owner' });
  } finally {
    await unknown.stop();
  }
});
