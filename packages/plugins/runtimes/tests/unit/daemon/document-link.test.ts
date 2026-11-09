/**
 * BG-033: the three documents of an account home outside the fleet follow a link out of the home (a home-manager home
 * links `settings.json` and `config.toml` into a store), and every condition that makes that safe. Real kernel roots over a
 * temp world; `SECRET` is a fake string, and no real home, key or credential is touched.
 *
 *   <parent>/store           a place outside every account home (the link targets)
 *   <parent>/person/linked   the account home outside the fleet
 *   <parent>/fy-home         the daemon's own home (the fence)
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import type { RuntimeHomeReader } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const LINKED = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 'SECRET-VALUE-THAT-MUST-NEVER-SURFACE';

/** Roots whose `harness-home` handles call `hook` after each `lstat` answers (the reader has then judged the file). */
function hooked(roots: RootsPort, hook: { current?: (path: string) => Promise<void> }): Pick<RootsPort, 'root'> {
  return {
    root: ((name: never, options?: never) => {
      const real = roots.root(name, options);
      if ((name as string) !== 'harness-home') return real;
      return new Proxy(real, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (key !== 'lstat' || typeof value !== 'function') return value;
          return async (path: string) => {
            const answer = await (value as (path: string) => Promise<unknown>).call(target, path);
            await hook.current?.(path);
            return answer;
          };
        },
      });
    }) as RootsPort['root'],
  };
}

async function seed(hook: { current?: (path: string) => Promise<void> } = {}) {
  const world = await fleetWorld();
  const store = join(world.parent, 'store');
  const linked = join(world.person, 'linked');
  await mkdir(store, { recursive: true });
  await mkdir(linked, { recursive: true });
  const manifest = buildFleetManifest({
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts: [
      {
        id: LINKED,
        kind: 'claude' as const,
        mode: 'interactive' as const,
        wrapper: `${world.fleet}/bin/w-a1`,
        home: linked,
        displayName: LINKED,
        defaultModel: 'm',
        models: [{ id: 'm', available: true as const }],
        available: true,
        unavailableReason: null,
      },
    ],
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
  return { world, store, linked, reader };
}

/** Everything a refusal carries, as one string, to search for a string or a path that must not be in it. */
const everythingOf = (error: unknown): string => {
  const failure = error as Error & { cause?: unknown };
  return JSON.stringify({
    message: failure.message,
    name: failure.name,
    stack: failure.stack,
    cause: String(failure.cause),
    own: Object.fromEntries(Object.getOwnPropertyNames(failure).map(key => [key, String((failure as never)[key])])),
  });
};

describe('BG-033 a document that is a link out of the home is followed, under every condition that makes it safe', () => {
  it('BG-033 HOSTILE LINK: settings.json linked to a private-key-looking file is refused with a sentence that names only the link', async () => {
    const { world, linked, reader } = await seed();
    const key = join(world.person, '.ssh', 'id_ed25519');
    await mkdir(join(key, '..'), { recursive: true });
    await writeFile(key, `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET}\n-----END OPENSSH PRIVATE KEY-----\n`);
    await symlink(key, join(linked, 'settings.json'));
    await symlink(key, join(linked, 'config.toml'));
    await symlink(key, join(linked, '.claude.json'));
    for (const file of ['settings.json', 'config.toml', '.claude.json'] as const) {
      const error = await reader()
        .document(file, 10_000)
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );
      expect(error).toBeInstanceOf(Error);
      const shown = everythingOf(error);
      expect(shown).not.toContain('SECRET');
      expect(shown).not.toContain('BEGIN');
      expect(shown).not.toContain('id_ed25519');
      expect(shown).not.toContain('.ssh');
      expect(shown).not.toContain(world.person);
      expect((error as Error).message).toContain(file);
    }
  });

  it('BG-033 a link to a valid JSON or TOML file of ANOTHER kind than the document is refused (the text must parse as the document)', async () => {
    const { store, linked, reader } = await seed();
    await writeFile(join(store, 'list.json'), '[1,2]');
    await writeFile(join(store, 'number.json'), '42');
    await writeFile(join(store, 'bad.toml'), `key = "${SECRET}\nnot toml`);
    await symlink(join(store, 'list.json'), join(linked, 'settings.json'));
    await symlink(join(store, 'number.json'), join(linked, '.claude.json'));
    await symlink(join(store, 'bad.toml'), join(linked, 'config.toml'));
    for (const file of ['settings.json', '.claude.json', 'config.toml'] as const) {
      const error = await reader()
        .document(file, 1000)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(everythingOf(error)).not.toContain('SECRET');
      expect((error as Error).message).toContain(`${file} is a link whose target is not read`);
    }
  });

  it('BG-033 a link to nothing answers absent (null), as a document that is not there', async () => {
    const { store, linked, reader } = await seed();
    await symlink(join(store, 'nothing.json'), join(linked, 'settings.json'));
    expect(await reader().document('settings.json', 1000)).toBeNull();
  });

  it('BG-033 a link to a folder, a pipe or a link loop is refused (never a regular file), naming only the link', async () => {
    const { store, linked, reader } = await seed();
    await mkdir(join(store, 'folder'), { recursive: true });
    spawnSync('mkfifo', [join(store, 'pipe')]);
    await symlink(join(store, 'folder'), join(linked, 'settings.json'));
    await symlink(join(store, 'pipe'), join(linked, '.claude.json'));
    await symlink(join(linked, 'config.toml'), join(linked, 'config.toml'));
    for (const file of ['settings.json', '.claude.json', 'config.toml'] as const)
      await expect(reader().document(file, 1000)).rejects.toThrow(`${file} is a link whose target is not read`);
  });

  it('BG-033 a link to a sign-in file anywhere (its real name, any case) is refused, and its text is never returned', async () => {
    const { store, linked, reader } = await seed();
    await writeFile(join(store, 'auth.json'), `{"k":"${SECRET}"}`);
    await writeFile(join(store, '.CREDENTIALS.json'), `{"k":"${SECRET}"}`);
    await symlink(join(store, 'auth.json'), join(linked, 'settings.json'));
    await symlink(join(store, 'innocent'), join(linked, '.claude.json'));
    await symlink(join(store, '.CREDENTIALS.json'), join(store, 'innocent'));
    for (const file of ['settings.json', '.claude.json'] as const) {
      const error = await reader()
        .document(file, 1000)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(everythingOf(error)).not.toContain('SECRET');
    }
  });

  it("BG-033 a link into the daemon's own home is refused (the kernel's fence), content-free", async () => {
    const { world, linked, reader } = await seed();
    await mkdir(join(world.home, 'state'), { recursive: true });
    await writeFile(join(world.home, 'state', 'private.json'), `{"k":"${SECRET}"}`);
    await writeFile(join(world.fleet, 'visible.json'), `{"k":"${SECRET}"}`);
    await symlink(join(world.home, 'state', 'private.json'), join(linked, 'settings.json'));
    await symlink(join(world.fleet, 'visible.json'), join(linked, '.claude.json'));
    for (const file of ['settings.json', '.claude.json'] as const) {
      const error = await reader()
        .document(file, 1000)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(everythingOf(error)).not.toContain('SECRET');
    }
  });

  it('BG-033 a link to a file with a second name is refused', async () => {
    const { store, linked, reader } = await seed();
    await writeFile(join(store, 'two.json'), `{"k":"${SECRET}"}`);
    await link(join(store, 'two.json'), join(store, 'two-again.json'));
    await symlink(join(store, 'two.json'), join(linked, 'settings.json'));
    const error = await reader()
      .document('settings.json', 1000)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(everythingOf(error)).not.toContain('SECRET');
  });

  it('BG-033 a file over the bound is refused, content-free: the caller’s bound, and the 16 MiB cap whatever the caller asks', async () => {
    const { store, linked, reader } = await seed();
    await writeFile(join(store, 'big.json'), `{"k":"${'x'.repeat(5000)}"}`);
    await symlink(join(store, 'big.json'), join(linked, 'settings.json'));
    await expect(reader().document('settings.json', 100)).rejects.toThrow('larger than the 100 bytes');
    await writeFile(join(store, 'huge.json'), `{"k":"${'x'.repeat(17 * 1024 * 1024)}"}`);
    await symlink(join(store, 'huge.json'), join(linked, '.claude.json'));
    await expect(reader().document('.claude.json', 64 * 1024 * 1024)).rejects.toThrow(
      `larger than the ${16 * 1024 * 1024} bytes`,
    );
  });

  it('BG-033 a target swapped for a link to another file after it was judged is discarded, never returned', async () => {
    const hook: { current?: (path: string) => Promise<void> } = {};
    const { store, linked, reader } = await seed(hook);
    await writeFile(join(store, 'real.json'), '{"a":1}');
    await writeFile(join(store, 'other.json'), `{"k":"${SECRET}"}`);
    await symlink(join(store, 'real.json'), join(linked, 'settings.json'));
    let swapped = false;
    hook.current = async path => {
      if (swapped || path !== join(store, 'real.json')) return;
      swapped = true;
      await rm(join(store, 'real.json'));
      await symlink(join(store, 'other.json'), join(store, 'real.json'));
    };
    const error = await reader()
      .document('settings.json', 1000)
      .catch((failure: unknown) => failure);
    expect(swapped).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(everythingOf(error)).not.toContain('SECRET');
  });

  it('BG-033 the other readers of the same home still do not follow a link out: skills stay skipped, a file in a skill is unreadable', async () => {
    const { store, linked, reader } = await seed();
    await mkdir(join(store, 'skill'), { recursive: true });
    await writeFile(join(store, 'skill', 'SKILL.md'), '# out\n');
    await mkdir(join(linked, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(linked, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    await symlink(join(store, 'skill'), join(linked, 'skills', 'store'));
    await symlink(join(store, 'skill', 'SKILL.md'), join(linked, 'skills', 'alpha', 'notes.md'));
    expect((await reader().skills(10)).map(skill => skill.name)).toEqual(['alpha']);
    expect(await reader().skillFile('alpha', 'notes.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });
});
