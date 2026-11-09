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
import { appendFile, link, mkdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import type { RuntimeHomeReader } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const LINKED = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 'SECRET-VALUE-THAT-MUST-NEVER-SURFACE';

type Hook = (method: 'realPath' | 'lstat', path: string) => Promise<void>;

/** What a `harness-home` handle was asked to read: the path and the byte bound of each `readDurable`. */
interface ReadLog {
  readonly reads: { readonly path: string; readonly limit: number | undefined }[];
  /** The `subfolder` each `harness-home` root was opened with. */
  readonly scopes: (string | undefined)[];
}

/**
 * Roots whose `harness-home` handles call `hook` after each `realPath` and `lstat` answers (the reader has then judged
 * the name), and record every `readDurable` and every scope a root was opened with in `log`.
 */
function hooked(
  roots: RootsPort,
  hook: { current?: Hook },
  log: ReadLog = { reads: [], scopes: [] },
): Pick<RootsPort, 'root'> {
  return {
    root: ((name: never, options?: { subfolder?: string }) => {
      const real = roots.root(name, options as never);
      if ((name as string) !== 'harness-home') return real;
      log.scopes.push(options?.subfolder);
      return new Proxy(real, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (typeof value !== 'function') return value;
          if (key === 'readDurable')
            return async (path: string, limit: number | undefined, use: never) => {
              log.reads.push({ path, limit });
              return await (value as (...args: unknown[]) => Promise<unknown>).call(target, path, limit, use);
            };
          if (key !== 'lstat' && key !== 'realPath') return value;
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

async function seed(hook: { current?: Hook } = {}, log?: ReadLog, build?: (world: FleetWorld) => RootsPort) {
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
  const api = fleetHomes(hooked(build?.(world) ?? world.roots, hook, log), new FleetPublication());
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
    for (const file of ['settings.json', '.claude.json', 'config.toml'] as const) {
      const error = await reader()
        .document(file, 1000)
        .catch((failure: unknown) => failure);
      expect((error as Error).message).toContain(`${file} is a link whose target is not read`);
      expect(everythingOf(error)).not.toContain(store);
    }
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
      // The sentence names the link, never where it leads.
      expect(everythingOf(error)).not.toContain(store);
      expect(everythingOf(error)).not.toContain('auth.json');
      expect(everythingOf(error)).not.toContain('CREDENTIALS');
      expect((error as Error).message).toContain(file);
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
      expect(everythingOf(error)).not.toContain(world.home);
      expect(everythingOf(error)).not.toContain('private.json');
      expect((error as Error).message).toContain(file);
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
    expect(everythingOf(error)).not.toContain(store);
    expect(everythingOf(error)).not.toContain('two.json');
    expect((error as Error).message).toContain('settings.json');
  });

  it('BG-033 a file over the bound is refused, content-free: the caller’s bound, and the 16 MiB cap whatever the caller asks', async () => {
    const log: ReadLog = { reads: [], scopes: [] };
    const { store, linked, reader } = await seed({}, log);
    await writeFile(join(store, 'big.json'), `{"k":"${'x'.repeat(5000)}"}`);
    await symlink(join(store, 'big.json'), join(linked, 'settings.json'));
    log.reads.length = 0;
    await expect(reader().document('settings.json', 100)).rejects.toThrow('larger than the 100 bytes');
    // The size is judged BEFORE a byte is read: nothing was read through the kernel for it.
    expect(log.reads).toEqual([]);
    // A SPARSE file over the cap (it allocates nothing): refused the same way, again without a read.
    await writeFile(join(store, 'huge.json'), '');
    await truncate(join(store, 'huge.json'), 17 * 1024 * 1024);
    await symlink(join(store, 'huge.json'), join(linked, '.claude.json'));
    await expect(reader().document('.claude.json', 64 * 1024 * 1024)).rejects.toThrow(
      `larger than the ${16 * 1024 * 1024} bytes`,
    );
    expect(log.reads).toEqual([]);
  });

  it('BG-033 the read root of a followed document is the TARGET’S OWN folder, never a wider one', async () => {
    const log: ReadLog = { reads: [], scopes: [] };
    const { store, linked, reader } = await seed({}, log);
    await writeFile(join(store, 'real.json'), '{"a":1}');
    await symlink(join(store, 'real.json'), join(linked, 'settings.json'));
    log.reads.length = 0;
    log.scopes.length = 0;
    expect(await reader().document('settings.json', 1000)).toBe('{"a":1}');
    expect(log.reads.map(read => read.path)).toEqual([join(store, 'real.json')]);
    // `/` only names the link's real path (nothing is read through it); the read itself is scoped to `store`.
    expect(log.scopes).toContain(store);
    expect(log.scopes.filter(scope => scope === '/').length).toBe(1);
  });

  it('BG-033 a target swapped for a link to another file after it was judged is discarded, never returned', async () => {
    const hook: { current?: Hook } = {};
    const { store, linked, reader } = await seed(hook);
    await writeFile(join(store, 'real.json'), '{"a":1}');
    await writeFile(join(store, 'other.json'), `{"k":"${SECRET}"}`);
    await symlink(join(store, 'real.json'), join(linked, 'settings.json'));
    let swapped = false;
    hook.current = async (method, path) => {
      if (swapped || method !== 'lstat' || path !== join(store, 'real.json')) return;
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

  it('BG-033 an empty or blank linked document is answered as the same file inside the home is (its own text), not refused', async () => {
    const { store, linked, reader } = await seed();
    for (const [file, text] of [
      ['settings.json', ''],
      ['.claude.json', ''],
      ['config.toml', ''],
      ['settings.json', ' \n'],
    ] as const) {
      await rm(join(linked, file), { force: true });
      await writeFile(join(linked, file), text);
      const inHome = await reader().document(file, 1000);
      await rm(join(linked, file));
      await writeFile(join(store, 'blank'), text);
      await symlink(join(store, 'blank'), join(linked, file));
      expect(inHome).toBe(text);
      expect(await reader().document(file, 1000)).toBe(inHome);
    }
  });

  it('BG-033 a target that GREW after it was judged, in place or by a bigger file moved over it, is refused content-free, never a prefix', async () => {
    for (const how of ['in place', 'replaced'] as const) {
      const hook: { current?: Hook } = {};
      const { store, linked, reader } = await seed(hook);
      const target = join(store, 'grow.toml');
      const longer = Array.from(
        { length: 100 },
        (_, index) => `k${String(index).padStart(3, '0')} = "${SECRET}"\n`,
      ).join('');
      await writeFile(target, 'a000 = 11\n');
      await writeFile(join(store, 'bigger.toml'), longer);
      await symlink(target, join(linked, 'config.toml'));
      let grown = false;
      hook.current = async (method, path) => {
        if (grown || method !== 'lstat' || path !== target) return;
        grown = true;
        if (how === 'in place') await appendFile(target, longer);
        else await rename(join(store, 'bigger.toml'), target);
      };
      const error = await reader()
        .document('config.toml', 100_000)
        .then(
          text => `RETURNED ${text}`,
          (failure: unknown) => failure,
        );
      expect(grown).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect(everythingOf(error)).not.toContain('SECRET');
      expect(everythingOf(error)).not.toContain(store);
      expect((error as Error).message).toContain('config.toml is a link whose target is not read');
    }
  });

  it('BG-033 R6 RESIDUAL a FOLDER above the target swapped for a link to another folder after the judge returns that folder’s same-named file (stated in document-link.ts)', async () => {
    const hook: { current?: Hook } = {};
    const { store, linked, reader } = await seed(hook);
    await mkdir(join(store, 'a'), { recursive: true });
    await mkdir(join(store, 'b'), { recursive: true });
    await writeFile(join(store, 'a', 'doc.json'), '{"from":"a"}');
    await writeFile(join(store, 'b', 'doc.json'), '{"from":"b"}');
    await symlink(join(store, 'a', 'doc.json'), join(linked, 'settings.json'));
    let swapped = false;
    hook.current = async (method, path) => {
      if (swapped || method !== 'realPath' || path !== join(linked, 'settings.json')) return;
      swapped = true;
      await rename(join(store, 'a'), join(store, 'a-old'));
      await symlink(join(store, 'b'), join(store, 'a'));
    };
    expect(await reader().document('settings.json', 1000)).toBe('{"from":"b"}');
    expect(swapped).toBe(true);
  });

  it('BG-033 R6 the same folder swap into the daemon’s home, or to a folder whose same-named file is a link to a sign-in file, is refused content-free', async () => {
    for (const into of ['fence', 'sign-in'] as const) {
      const hook: { current?: Hook } = {};
      const { world, store, linked, reader } = await seed(hook);
      await mkdir(join(store, 'a'), { recursive: true });
      await writeFile(join(store, 'a', 'doc.json'), '{"from":"a"}');
      const elsewhere = into === 'fence' ? join(world.home, 'state') : join(store, 'b');
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, into === 'fence' ? 'doc.json' : '.credentials.json'), `{"k":"${SECRET}"}`);
      if (into === 'sign-in') await symlink('.credentials.json', join(elsewhere, 'doc.json'));
      await symlink(join(store, 'a', 'doc.json'), join(linked, 'settings.json'));
      let swapped = false;
      hook.current = async (method, path) => {
        if (swapped || method !== 'realPath' || path !== join(linked, 'settings.json')) return;
        swapped = true;
        await rename(join(store, 'a'), join(store, 'a-old'));
        await symlink(elsewhere, join(store, 'a'));
      };
      const error = await reader()
        .document('settings.json', 1000)
        .catch((failure: unknown) => failure);
      expect(swapped).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect(everythingOf(error)).not.toContain('SECRET');
    }
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
