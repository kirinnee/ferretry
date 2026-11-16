/**
 * `RootHandle.checkPrivateChain` on the real disk: every component from the home down to a folder is owned by the daemon,
 * is a plain directory (no link) and is neither group- nor other-writable. This is the v4 launch-overlay policy
 * (`FileLaunchOverlayFiles#ensureDirectory`) as a kernel fact, so a credential-bearing file is never written under a
 * folder somebody else can swap, add to or rename in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { DirectoryChainFault, RootHandle } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const UID = process.getuid?.() ?? 0;
const PLUGIN = 'claude-code';
const FERRET = 'F1';

interface Fixture {
  readonly home: string;
  readonly root: RootHandle;
  readonly target: FencedPath;
  /** The folder as the disk has it, per component (relative to the home; `''` is the home). */
  readonly at: (component: string) => string;
}

async function fixture(
  options: { readonly fs?: (disk: HostFs) => HostFs; readonly uid?: number } = {},
): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-chain-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  const layout = { home, plugin: PLUGIN, worktrees: `${home}-worktrees` };
  const disk = nodeFs(() => 'x');
  const refused = await ensureInternalRootBases(disk, layout, ['agent-homes']);
  if (refused.length > 0) throw new Error(`base refused: ${refused[0]?.refusal ?? '?'}`);
  const port = rootsPortFor(options.fs?.(disk) ?? disk, layout, ['agent-homes'], () => undefined, {
    ...(options.uid === undefined ? {} : { daemonUid: options.uid }),
  });
  const root = port.root('agent-homes', { subfolder: FERRET });
  const resolved = root.resolve('.');
  if (!resolved.ok) throw new Error(resolved.error);
  await mkdir(`${home}/state/${PLUGIN}/agent-homes/${FERRET}`, { recursive: true, mode: 0o700 });
  return { home, root, target: resolved.value, at: component => (component === '' ? home : `${home}/${component}`) };
}

const faultOf = async (root: RootHandle, path: FencedPath): Promise<DirectoryChainFault | 'safe'> => {
  const verdict = await root.checkPrivateChain(path);
  return verdict.ok ? 'safe' : verdict.error.fault;
};

describe('RootHandle.checkPrivateChain (real disk)', () => {
  test('a healthy 0700 chain passes', async () => {
    const f = await fixture();
    expect(await faultOf(f.root, f.target)).toBe('safe');
  });

  test('a healthy 0755 chain passes (readable by others, writable by the owner alone)', async () => {
    const f = await fixture();
    for (const part of [
      '',
      'state',
      `state/${PLUGIN}`,
      `state/${PLUGIN}/agent-homes`,
      `state/${PLUGIN}/agent-homes/${FERRET}`,
    ])
      await chmod(f.at(part), 0o755);
    expect(await faultOf(f.root, f.target)).toBe('safe');
  });

  // The review's four probes: each ancestor made 0777 AFTER the roots were built, each must refuse and name itself.
  for (const [label, component] of [
    ['FY_HOME', ''],
    ['state', 'state'],
    ['state/<plugin>', `state/${PLUGIN}`],
    ['agent-homes', `state/${PLUGIN}/agent-homes`],
    ['the ferret folder itself', `state/${PLUGIN}/agent-homes/${FERRET}`],
  ] as const) {
    test(`${label} at 0777 refuses, names the component and is left as it was`, async () => {
      const f = await fixture();
      await chmod(f.at(component), 0o777);
      const verdict = await f.root.checkPrivateChain(f.target);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.error.fault).toBe('writable_by_others');
      expect(verdict.error.component).toBe(component === '' ? '.' : component);
      expect(verdict.error.reason).toContain(component === '' ? 'the home' : component);
      // never silently chmod an ancestor
      expect((await Bun.file(f.at(component)).stat()).mode & 0o777).toBe(0o777);
    });
  }

  test('group-writable alone refuses too', async () => {
    const f = await fixture();
    await chmod(f.at(`state/${PLUGIN}`), 0o770);
    expect(await faultOf(f.root, f.target)).toBe('writable_by_others');
  });

  test('other-writable alone refuses too', async () => {
    const f = await fixture();
    await chmod(f.at('state'), 0o703);
    expect(await faultOf(f.root, f.target)).toBe('writable_by_others');
  });

  test('a symlinked ancestor refuses, whatever it points at', async () => {
    const f = await fixture();
    const aside = `${f.at('')}-aside`;
    await mkdir(aside, { mode: 0o700 });
    const folder = f.at(`state/${PLUGIN}/agent-homes`);
    await rm(`${folder}/${FERRET}`, { recursive: true });
    await mkdir(`${aside}/${FERRET}`, { mode: 0o700 });
    await symlink(`${aside}/${FERRET}`, `${folder}/${FERRET}`);
    const verdict = await f.root.checkPrivateChain(f.target);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error.fault).toBe('link');
    expect(verdict.error.component).toBe(`state/${PLUGIN}/agent-homes/${FERRET}`);
  });

  test('a symlinked middle component refuses', async () => {
    const f = await fixture();
    const aside = `${f.at('')}-aside`;
    await mkdir(`${aside}/agent-homes/${FERRET}`, { recursive: true, mode: 0o700 });
    await rm(f.at(`state/${PLUGIN}/agent-homes`), { recursive: true });
    await symlink(`${aside}/agent-homes`, f.at(`state/${PLUGIN}/agent-homes`));
    expect(await faultOf(f.root, f.target)).toBe('link');
  });

  test('a component owned by another user refuses (the stat is injected, no root needed)', async () => {
    const foreign = `state/${PLUGIN}`;
    let home = '';
    const f = await fixture({
      fs: disk => ({
        ...disk,
        identity: async path => {
          const found = await disk.identity(path);
          return found !== undefined && path === `${home}/${foreign}` ? { ...found, owner: UID + 1 } : found;
        },
      }),
      uid: UID,
    });
    home = f.home;
    const verdict = await f.root.checkPrivateChain(f.target);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error.fault).toBe('foreign_owner');
    expect(verdict.error.component).toBe(foreign);
  });

  test('a daemon uid that is unknown fails closed', async () => {
    const f = await fixture();
    const unknown = rootsPortFor(
      nodeFs(() => 'x'),
      { home: f.home, plugin: PLUGIN, worktrees: `${f.home}-worktrees` },
      ['agent-homes'],
      () => undefined,
      { daemonUid: null },
    ).root('agent-homes', { subfolder: FERRET });
    expect(await faultOf(unknown, f.target)).toBe('unknown_owner');
  });

  test('a missing component refuses (nothing is made by a check)', async () => {
    const f = await fixture();
    await rm(f.at(`state/${PLUGIN}/agent-homes/${FERRET}`), { recursive: true });
    const verdict = await f.root.checkPrivateChain(f.target);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error.fault).toBe('missing');
    expect(verdict.error.component).toBe(`state/${PLUGIN}/agent-homes/${FERRET}`);
    expect(await Bun.file(f.at(`state/${PLUGIN}/agent-homes/${FERRET}`)).exists()).toBe(false);
  });

  test('a file where a folder should be refuses', async () => {
    const f = await fixture();
    await rm(f.at(`state/${PLUGIN}/agent-homes/${FERRET}`), { recursive: true });
    await Bun.write(f.at(`state/${PLUGIN}/agent-homes/${FERRET}`), 'x');
    expect(await faultOf(f.root, f.target)).toBe('not_directory');
  });

  test('a swap AFTER a pass is caught by asking again right before use', async () => {
    const f = await fixture();
    expect(await faultOf(f.root, f.target)).toBe('safe');
    await chmod(f.at('state'), 0o777);
    expect(await faultOf(f.root, f.target)).toBe('writable_by_others');
  });

  test('a path outside the root is refused as every other call refuses it', async () => {
    const f = await fixture();
    await expect(f.root.checkPrivateChain('/etc' as FencedPath)).rejects.toThrow();
  });

  test('the reason names a component and never a secret or the absolute home', async () => {
    const f = await fixture();
    await chmod(f.at(`state/${PLUGIN}`), 0o777);
    const verdict = await f.root.checkPrivateChain(f.target);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.error.reason).not.toContain(f.home);
  });

  test('a root that is not below the home has no chain to judge and refuses', async () => {
    const f = await fixture();
    const owner = rootsPortFor(
      nodeFs(() => 'x'),
      { home: f.home, plugin: 'runtimes', worktrees: `${f.home}-worktrees` },
      ['harness-home'],
      () => undefined,
      { daemonUid: UID },
    ).root('harness-home', { subfolder: tmpdir() });
    const resolved = owner.resolve('.');
    if (!resolved.ok) throw new Error(resolved.error);
    const verdict = await owner.checkPrivateChain(resolved.value);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.fault).toBe('outside_home');
  });
});
