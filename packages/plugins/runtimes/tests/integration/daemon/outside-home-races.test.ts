/**
 * BG-033: what an account home outside the fleet may NOT return when a name is swapped for a link while it is read, and
 * the guards of the handle itself. Real kernel roots over a temp world; a hook on the roots swaps a name at the exact
 * moment a race would (right after the reader's own `realPath` or listing). `SECRET` is a fake string.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import type { RuntimeHomeReader } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import { followingHandle } from '../../../daemon/adapters/following-handle.ts';
import { isSignInName } from '../../../daemon/lib/account/credentials.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

const LINKED = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 'SECRET-VALUE-THAT-MUST-NEVER-SURFACE';

const account = (world: FleetWorld, id: string, home: string) => ({
  id,
  kind: 'claude' as const,
  mode: 'interactive' as const,
  wrapper: `${world.fleet}/bin/w-${id.slice(-2)}`,
  home,
  displayName: id,
  defaultModel: 'm',
  models: [{ id: 'm', available: true as const }],
  available: true,
  unavailableReason: null,
});

type Hook = (method: 'realPath' | 'entries', path: string) => Promise<void>;

/** Roots whose `harness-home` handles call `hook` AFTER each `realPath` and `entries` answer, before the reader goes on. */
function hooked(roots: RootsPort, hook: { current?: Hook }): Pick<RootsPort, 'root'> {
  return {
    root: ((name: never, options?: never) => {
      const real = roots.root(name, options);
      if ((name as string) !== 'harness-home') return real;
      return new Proxy(real, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if ((key !== 'realPath' && key !== 'entries') || typeof value !== 'function') return value;
          return async (path: string) => {
            const answer = await (value as (path: string) => Promise<unknown>).call(target, path);
            await hook.current?.(key, path);
            return answer;
          };
        },
      });
    }) as RootsPort['root'],
  };
}

async function seed(hook: { current?: Hook } = {}) {
  const world = await fleetWorld();
  const linked = join(world.person, 'linked');
  await mkdir(join(linked, 'skills'), { recursive: true });
  const manifest = buildFleetManifest({
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts: [account(world, LINKED, linked)],
    runtimes: [],
  });
  await writeFile(join(world.fleet, 'manifest.json'), JSON.stringify(manifest));
  const api = fleetHomes(hooked(world.roots, hook), new FleetPublication());
  await api.homes();
  const reader = (): RuntimeHomeReader => {
    const found = api.home(LINKED);
    if (found === undefined) throw new Error('the home is not published');
    return found;
  };
  return { world, linked, reader };
}

const put = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

/** Swaps `target` for a link to `to` the first time `when` says so. */
function swap(hook: { current?: Hook }, target: string, to: string, when: (method: string, path: string) => boolean) {
  const state = { swapped: false };
  hook.current = async (method, path) => {
    if (state.swapped || !when(method, path)) return;
    state.swapped = true;
    await rm(target);
    await symlink(to, target);
  };
  return state;
}

describe('BG-033 a name swapped for a link after it was judged is refused, never returned', () => {
  it('BG-033 skillFile: a file swapped for a link to the home sign-in file between the judge and the read', async () => {
    const hook: { current?: Hook } = {};
    const { linked, reader } = await seed(hook);
    await put(join(linked, '.credentials.json'), SECRET);
    await put(join(linked, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    const target = join(linked, 'skills', 'alpha', 'a.md');
    await put(target, 'plain');
    const state = swap(
      hook,
      target,
      join(linked, '.credentials.json'),
      (method, path) => method === 'realPath' && path === target,
    );
    const read = await reader().skillFile('alpha', 'a.md', 1000);
    expect(state.swapped).toBe(true);
    expect(read).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('BG-033 skillManifest: SKILL.md swapped for a link to the sign-in file between the judge and the read', async () => {
    const hook: { current?: Hook } = {};
    const { linked, reader } = await seed(hook);
    await put(join(linked, '.credentials.json'), SECRET);
    const target = join(linked, 'skills', 'alpha', 'SKILL.md');
    await put(target, '# alpha\n');
    const state = swap(
      hook,
      target,
      join(linked, '.credentials.json'),
      (method, path) => method === 'realPath' && path === target,
    );
    expect(await reader().skillManifest('alpha', 1000)).toBeUndefined();
    expect(state.swapped).toBe(true);
  });

  it('BG-033 document: settings.json swapped for a link to the sign-in file between the judge and the read', async () => {
    const hook: { current?: Hook } = {};
    const { linked, reader } = await seed(hook);
    await put(join(linked, '.credentials.json'), SECRET);
    const target = join(linked, 'settings.json');
    await put(target, '{"a":1}');
    const state = swap(
      hook,
      target,
      join(linked, '.credentials.json'),
      (method, path) => method === 'realPath' && path === target,
    );
    const text = await reader()
      .document('settings.json', 1000)
      .catch((error: Error) => error.message);
    expect(state.swapped).toBe(true);
    expect(text).not.toContain('SECRET');
    expect(text).not.toBe('{"a":1}');
  });

  it('BG-033 skillFile never follows a link: a file swapped for a link to ANOTHER file of the folder after the listing is refused', async () => {
    const hook: { current?: Hook } = {};
    const { linked, reader } = await seed(hook);
    await put(join(linked, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    const target = join(linked, 'skills', 'alpha', 'a.md');
    await put(target, 'plain');
    await put(join(linked, 'skills', 'alpha', 'b.md'), 'the other file');
    const state = swap(
      hook,
      target,
      join(linked, 'skills', 'alpha', 'b.md'),
      (method, path) => method === 'entries' && path === join(linked, 'skills', 'alpha'),
    );
    expect(await reader().skillFile('alpha', 'a.md', 1000)).toEqual({ ok: false, reason: 'unreadable' });
    expect(state.swapped).toBe(true);
  });
});

describe('BG-033 the handle judges every read and refuses to leave its folder by name', () => {
  it('BG-033 a read of a sign-in file is refused, directly and through a link of another name', async () => {
    const { world, linked } = await seed();
    await put(join(linked, 'auth.json'), SECRET);
    await put(join(linked, '.Credentials.JSON'), SECRET);
    await symlink(join(linked, 'auth.json'), join(linked, 'innocent.md'));
    const handle = followingHandle(world.roots, linked, linked, true);
    for (const name of ['auth.json', '.Credentials.JSON', 'innocent.md']) {
      const placed = handle.resolve(name);
      if (!placed.ok) throw new Error(`${name} did not resolve`);
      await expect(handle.readText(placed.value, 1000)).rejects.toThrow('the file is not read');
      await expect(handle.readBytes(placed.value, 1000)).rejects.toThrow('the file is not read');
    }
  });

  it('BG-033 the sign-in names have ONE owner (account/credentials.ts), judged in any letter case', () => {
    for (const name of ['.credentials.json', 'auth.json', '.Credentials.JSON', 'AUTH.json'])
      expect(isSignInName(name)).toBe(true);
    for (const name of ['credentials.json', 'auth.json.bak', 'settings.json', ''])
      expect(isSignInName(name)).toBe(false);
  });

  it('BG-033 a name that climbs (a `..` segment anywhere) or holds a NUL is outside, even when it lands back inside the folder', async () => {
    const { world, linked } = await seed();
    const handle = followingHandle(world.roots, linked, join(linked, 'skills'), true);
    expect(handle.resolve('../x')).toEqual({ ok: false, error: 'outside' });
    expect(handle.resolve('sub/../x')).toEqual({ ok: false, error: 'outside' });
    expect(handle.resolve('a\0b')).toEqual({ ok: false, error: 'outside' });
    expect(handle.resolve('ok/x').ok).toBe(true);
  });
});
