/**
 * The file provisioner over the kernel's REAL `fleet` and `harness-home` roots (a mkdtemp fixture): what an apply writes,
 * what it refuses before it touches anything, and that a failure puts the fleet folder back exactly as it was.
 *
 * Rows touched: S43 (a component source in the daemon's home is refused at apply), S44 (destinations are reached only
 * through the root: a link on the way refuses the apply; a backup is deleted only after the apply commits), S67 (an apply
 * publishes exclusively, a read waits), S68 (documents and the manifest are 0600), S144 (a sign-in is never copied: it is
 * linked, and nothing reads it).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetApplyFailureError, type FleetApplyPlan } from '../../../daemon/lib/provisioning.ts';
import type { FleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const manifest = (): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  runtimes: [],
  accounts: [
    {
      secretEnv: {},
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'claude',
      mode: 'auto',
      wrapper: '/placeholder/bin/alias-with-hyphens',
      home: '/placeholder/homes/one',
      displayName: 'Placeholder Account',
      defaultModel: 'model-one',
      models: [{ id: 'model-one', displayName: 'Model One', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
});

const planFor = (world: FleetWorld, operations: FleetApplyPlan['operations']): FleetApplyPlan => ({
  manifest: manifest(),
  manifestPath: join(world.fleet, 'manifest.json'),
  operations,
});

const exists = async (path: string): Promise<boolean> =>
  await lstat(path).then(
    () => true,
    () => false,
  );

/** Every path under `directory`, relative and sorted, links not followed: what a rollback must leave unchanged. */
async function tree(directory: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(directory)).toSorted()) {
    const full = join(directory, name);
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const found = await lstat(full);
    if (found.isDirectory()) out.push(`${relative}/`, ...(await tree(full, relative)));
    else if (found.isSymbolicLink()) out.push(`${relative} -> ${await readlink(full)}`);
    else out.push(`${relative} = ${await readFile(full, 'utf8')}`);
  }
  return out;
}

const failureOf = async (act: Promise<unknown>): Promise<FleetApplyFailureError> => {
  const error = await act.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(FleetApplyFailureError);
  return error as FleetApplyFailureError;
};

describe('FileFleetProvisioner over the fleet root', () => {
  it('creates the fleet folder itself, because a first run has nothing else to create', async () => {
    const world = await fleetWorld();
    const plan = planFor(world, [{ kind: 'directory', path: world.fleet, mode: 0o700 }]);

    const result = await world.provisioner().apply(plan);

    expect(result.operationCount).toBe(1);
    expect((await stat(world.fleet)).isDirectory()).toBe(true);
  });

  it('S68 writes files, copies and links, and the manifest last, at 0600', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'asset.txt'), 'placeholder material\n');
    const wrapper = join(world.fleet, 'bin', 'alias-with-hyphens');
    const copied = join(world.fleet, 'homes', 'one', 'asset.txt');
    const linked = join(world.fleet, 'homes', 'one', 'linked.txt');
    const plan = planFor(world, [
      { kind: 'directory', path: join(world.fleet, 'bin'), mode: 0o700 },
      { kind: 'file', path: wrapper, content: '#!/bin/sh\nexec true "$@"\n', mode: 0o700 },
      { kind: 'copy', source: join(world.fleet, 'assets', 'asset.txt'), path: copied, mode: 0o600 },
      { kind: 'symlink', source: join(world.fleet, 'assets', 'asset.txt'), path: linked },
    ]);

    const result = await world.provisioner().apply(plan);

    expect(result).toEqual({
      accountCount: 1,
      operationCount: 4,
      manifestPath: plan.manifestPath,
      prunedWrappers: [],
      sharedHistory: [],
    });
    expect(await readFile(wrapper, 'utf8')).toContain('exec true');
    expect((await stat(wrapper)).mode & 0o777).toBe(0o700);
    expect(await readFile(copied, 'utf8')).toBe('placeholder material\n');
    expect((await stat(copied)).mode & 0o777).toBe(0o600);
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(plan.manifestPath, 'utf8'))).toEqual(manifest());
    expect((await stat(plan.manifestPath)).mode & 0o777).toBe(0o600);
    // The commit discarded every backup: nothing of the machinery is left in the folder.
    expect((await tree(world.fleet)).filter(line => line.includes('.fy-fleet-'))).toEqual([]);
  });

  it('refuses a destination outside the fleet folder, and a path that climbs out, touching nothing', async () => {
    const world = await fleetWorld();
    const outside = join(world.parent, 'elsewhere', 'file.txt');
    const climbing = join(world.fleet, 'homes', '..', '..', 'escape.txt');
    const before = await tree(world.fleet);

    for (const path of [outside, climbing]) {
      const act = world.provisioner().apply(planFor(world, [{ kind: 'file', path, content: 'x', mode: 0o600 }]));
      await expect(act).rejects.toThrow(/refusing to write outside configured fleet roots/u);
    }

    expect(await tree(world.fleet)).toEqual(before);
    expect(await exists(outside)).toBe(false);
    expect(await exists(join(world.home, 'escape.txt'))).toBe(false);
  });

  it('S44 refuses a link on the way to a destination and writes nothing through it', async () => {
    const world = await fleetWorld();
    const target = join(world.parent, 'target');
    await mkdir(target, { recursive: true });
    await mkdir(join(world.fleet, 'homes'), { recursive: true });
    await symlink(target, join(world.fleet, 'homes', 'one'));

    const act = world
      .provisioner()
      .apply(
        planFor(world, [
          { kind: 'file', path: join(world.fleet, 'homes', 'one', 'settings.json'), content: '{}', mode: 0o600 },
        ]),
      );

    await expect(act).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
  });

  it('S43 refuses a copy or a link whose source is in the daemon’s home, before any write', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.home, 'config'), { recursive: true });
    await writeFile(join(world.home, 'config', 'machine.yaml'), 'secret: nope\n');
    const before = await tree(world.fleet);

    for (const operation of [
      {
        kind: 'copy' as const,
        source: join(world.home, 'config', 'machine.yaml'),
        path: join(world.fleet, 'homes', 'one', 'a'),
      },
      { kind: 'symlink' as const, source: join(world.home, 'config'), path: join(world.fleet, 'homes', 'one', 'b') },
      // The fleet's own homes and credentials are not component sources either: only `assets/` is.
      {
        kind: 'copy' as const,
        source: join(world.fleet, 'credentials', 'x', 'auth.json'),
        path: join(world.fleet, 'homes', 'one', 'c'),
      },
    ]) {
      const act = world.provisioner().apply(planFor(world, [operation]));
      await expect(act).rejects.toThrow(/outside the folders Runtimes may read a component from/u);
    }

    expect(await tree(world.fleet)).toEqual(before);
  });

  it('S144 never copies a sign-in: a copied folder holding one is refused whole, and a credential link reads nothing', async () => {
    const world = await fleetWorld();
    const INERT = 'INERT_SIGN_IN_FIXTURE';
    await mkdir(join(world.person, '.codex', 'bundle'), { recursive: true });
    await writeFile(join(world.person, '.codex', 'bundle', 'auth.json'), INERT);
    await writeFile(join(world.person, '.codex', 'bundle', 'notes.md'), 'fine');
    await writeFile(join(world.person, '.codex', 'auth.json'), INERT);

    const copy = world.provisioner().apply(
      planFor(world, [
        {
          kind: 'copy',
          source: join(world.person, '.codex', 'bundle'),
          path: join(world.fleet, 'homes', 'one', 'bundle'),
        },
      ]),
    );
    await expect(copy).rejects.toThrow(/a sign-in file; a credential is stored once and linked, never read or copied/u);
    expect(await exists(join(world.fleet, 'homes', 'one', 'bundle'))).toBe(false);

    const link = join(world.fleet, 'homes', 'one', 'auth.json');
    await world.provisioner().apply(
      planFor(world, [
        { kind: 'directory', path: join(world.fleet, 'homes', 'one'), mode: 0o700 },
        { kind: 'symlink', source: join(world.person, '.codex', 'auth.json'), path: link },
      ]),
    );
    // The link leads to the person's own sign-in: stored once, never copied.
    expect(await readlink(link)).toBe(await realpath(join(world.person, '.codex', 'auth.json')));
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(world.person, '.codex', 'auth.json'), 'utf8')).toBe(INERT);
  });

  it('S144 links an empty sign-in slot that does not exist yet (dangling), and refuses a missing target otherwise', async () => {
    const world = await fleetWorld();
    const slot = join(world.person, '.codex', 'auth.json');
    const link = join(world.fleet, 'homes', 'one', 'auth.json');
    const dir = { kind: 'directory' as const, path: join(world.fleet, 'homes', 'one'), mode: 0o700 };

    const refused = world.provisioner().apply(planFor(world, [dir, { kind: 'symlink', source: slot, path: link }]));
    await expect(refused).rejects.toThrow(/does not exist/u);
    expect(await exists(join(world.fleet, 'homes'))).toBe(false);

    await world
      .provisioner()
      .apply(planFor(world, [dir, { kind: 'symlink', source: slot, path: link, dangling: true }]));
    expect(await readlink(link)).toBe(slot);
  });

  it('S43 refuses an apply whose copy source is a link in assets/ out to the fleet’s credentials or homes, before any write', async () => {
    const world = await fleetWorld();
    const INERT = 'INERT_SIGN_IN_FIXTURE';
    await mkdir(join(world.fleet, 'credentials', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'credentials', 'one', 'auth.json'), INERT);
    await writeFile(join(world.fleet, 'credentials', 'one', 'api-key'), INERT);
    await mkdir(join(world.fleet, 'homes', 'two'), { recursive: true });
    await writeFile(join(world.fleet, 'homes', 'two', 'history.jsonl'), INERT);
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await symlink('../credentials/one/auth.json', join(world.fleet, 'assets', 'readme.md'));
    await symlink('../homes/two/history.jsonl', join(world.fleet, 'assets', 'history.md'));
    await symlink('../credentials', join(world.fleet, 'assets', 'folder'));
    const before = await tree(world.fleet);

    for (const name of ['readme.md', 'history.md', 'folder']) {
      const operation = {
        kind: 'copy' as const,
        source: join(world.fleet, 'assets', name),
        path: join(world.fleet, 'homes', 'one', name),
      };
      await expect(world.provisioner().apply(planFor(world, [operation]))).rejects.toThrow();
      // A link is judged like a copy: it must not lead a runtime out of assets/ either.
      await expect(
        world.provisioner().apply(planFor(world, [{ ...operation, kind: 'symlink' as const }])),
      ).rejects.toThrow();
    }

    expect(await tree(world.fleet)).toEqual(before);
  });

  it('M1 an apply with a Ferretry-kept Codex login links its stored credential (dangling, nothing read) and a copy of it is refused', async () => {
    const world = await fleetWorld();
    const stored = join(world.fleet, 'credentials', 'one', 'auth.json');
    await mkdir(join(world.fleet, 'credentials', 'one'), { recursive: true });
    const link = join(world.fleet, 'homes', 'one', 'auth.json');
    const home = { kind: 'directory' as const, path: join(world.fleet, 'homes', 'one'), mode: 0o700 };

    await world
      .provisioner()
      .apply(planFor(world, [home, { kind: 'symlink', source: stored, path: link, dangling: true }]));

    expect(await readlink(link)).toBe(stored);
    // The sign-in the harness then writes THROUGH the link lands in the stored place, and is still never a copy source.
    await writeFile(stored, 'INERT_SIGN_IN_FIXTURE');
    const before = await tree(world.fleet);
    for (const source of [stored, join(world.fleet, 'credentials', 'one')]) {
      await expect(
        world
          .provisioner()
          .apply(planFor(world, [{ kind: 'copy', source, path: join(world.fleet, 'homes', 'one', 'copy') }])),
      ).rejects.toThrow(/outside the folders Runtimes may read a component from/u);
    }
    // And not through a link that is NOT the dangling credential link.
    await expect(
      world
        .provisioner()
        .apply(planFor(world, [{ kind: 'symlink', source: stored, path: join(world.fleet, 'homes', 'one', 'other') }])),
    ).rejects.toThrow(/outside the folders Runtimes may read a component from/u);
    expect(await tree(world.fleet)).toEqual(before);
  });

  it('S144 C2 refuses an apply whose file source is a link to a sign-in, before any write', async () => {
    const world = await fleetWorld();
    await writeFile(join(world.person, '.claude', '.credentials.json'), 'INERT_SIGN_IN_FIXTURE');
    await symlink('.credentials.json', join(world.person, '.claude', 'notes.md'));
    const before = await tree(world.fleet);

    const act = world.provisioner().apply(
      planFor(world, [
        {
          kind: 'copy',
          source: join(world.person, '.claude', 'notes.md'),
          path: join(world.fleet, 'homes', 'one', 'notes.md'),
        },
      ]),
    );

    await expect(act).rejects.toThrow(/a sign-in file/u);
    expect(await tree(world.fleet)).toEqual(before);
  });

  it('rolls every earlier write back when a later one fails, a replaced file and a replaced link included', async () => {
    const world = await fleetWorld();
    const keepFile = join(world.fleet, 'homes', 'one', 'keep.txt');
    const keepLink = join(world.fleet, 'homes', 'one', 'keep-link');
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(keepFile, 'original\n');
    await symlink('/nonexistent/original-target', keepLink);
    const settings = join(world.fleet, 'homes', 'one', 'settings.json');
    await writeFile(settings, '{ this is not json');
    const before = await tree(world.fleet);

    const act = world.provisioner().apply(
      planFor(world, [
        { kind: 'directory', path: join(world.fleet, 'bin'), mode: 0o700 },
        { kind: 'file', path: keepFile, content: 'replaced\n', mode: 0o600 },
        { kind: 'file', path: keepLink, content: 'now a file\n', mode: 0o600 },
        // Fails at apply: an existing settings file that cannot be parsed is never silently replaced.
        {
          kind: 'settings',
          path: settings,
          format: 'json',
          layers: [{ from: 'inline', settings: { a: 1 } }],
          preserveExisting: true,
          mode: 0o600,
        },
      ]),
    );

    const failure = await failureOf(act);
    expect(failure.failure.kind).toBe('rolled-back');
    expect(await tree(world.fleet)).toEqual(before);
    // A link restored is a LINK, not a file with its target's text.
    expect(await readlink(keepLink)).toBe('/nonexistent/original-target');
  });

  it('reports a rollback that could not restore an entry somebody else changed, and keeps the original', async () => {
    const world = await fleetWorld();
    const file = join(world.fleet, 'homes', 'one', 'keep.txt');
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(file, 'original\n');
    const real = world.disk;
    // Somebody edits the file this apply just wrote, then a later step fails.
    const meddling = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'setMode') {
          return async () => {
            await writeFile(file, 'edited by somebody else\n');
            throw new Error('a later step failed');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const act = world.provisioner({ disk: meddling }).apply(
      planFor(world, [
        { kind: 'file', path: file, content: 'replaced\n', mode: 0o600 },
        { kind: 'directory', path: join(world.fleet, 'bin'), mode: 0o700 },
      ]),
    );

    const failure = (await failureOf(act)).failure;
    expect(failure.kind).toBe('rollback-incomplete');
    if (failure.kind !== 'rollback-incomplete') throw new Error('unreachable');
    expect(failure.unrestored.map(entry => entry.path)).toContain(file);
    // The edit is kept, and the only copy of the original is named, not deleted.
    expect(await readFile(file, 'utf8')).toBe('edited by somebody else\n');
    const backup = failure.unrestored.find(entry => entry.path === file)?.backup;
    expect(backup).toBeDefined();
    expect(await readFile(backup as string, 'utf8')).toBe('original\n');
  });

  it('refuses to replace a name that appeared after it was cleared, and rolls back', async () => {
    const world = await fleetWorld();
    const file = join(world.fleet, 'homes', 'one', 'late.txt');
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    const real = world.disk;
    const racing = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'create') {
          return async (path: string, bytes: Uint8Array, mode: number) => {
            if (path === file) await writeFile(file, 'arrived first\n');
            return await target.create(path, bytes, mode);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const act = world
      .provisioner({ disk: racing })
      .apply(planFor(world, [{ kind: 'file', path: file, content: 'mine\n', mode: 0o600 }]));

    const failure = await failureOf(act);
    expect(failure.failure.kind === 'rolled-back' || failure.failure.kind === 'rollback-incomplete').toBe(true);
    expect(failure.message).toMatch(/something arrived at the name after it was cleared/u);
    expect(await readFile(file, 'utf8')).toBe('arrived first\n');
  });

  it('S67 publishes exclusively: a read of the fleet waits until the apply has committed', async () => {
    const world = await fleetWorld();
    const publication = new FleetPublication();
    const events: string[] = [];
    let entered: () => void = () => undefined;
    const inside = new Promise<void>(resolve => {
      entered = resolve;
    });
    const provisioner = world.provisioner({
      publishing: async mutate =>
        await publication.publishing(async () => {
          events.push('mutating');
          entered();
          const result = await mutate();
          events.push('mutated');
          return result;
        }),
    });
    const plan = planFor(world, [{ kind: 'file', path: join(world.fleet, 'bin', 'w'), content: 'x', mode: 0o700 }]);

    const applying = provisioner.apply(plan);
    // The claim is held and the mutation has begun; a read asked NOW must not see the gap, so it waits for the commit.
    await inside;
    const reading = publication.reading(async () => {
      events.push('read');
      return await exists(plan.manifestPath);
    });

    expect(await reading).toBe(true);
    await applying;
    expect(events).toEqual(['mutating', 'mutated', 'read']);
  });

  it('S67 a failed apply is rolled back INSIDE the exclusive section, so no read sees the half-applied fleet', async () => {
    const world = await fleetWorld();
    const publication = new FleetPublication();
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const provisioner = world.provisioner({
      publishing: async mutate => await publication.publishing(mutate),
    });
    const bad = planFor(world, [
      { kind: 'file', path: join(world.fleet, 'bin', 'w'), content: 'x', mode: 0o700 },
      { kind: 'copy', source: join(world.fleet, 'assets', 'missing'), path: join(world.fleet, 'bin', 'c') },
    ]);

    const applying = provisioner.apply(bad).catch(() => undefined);
    const reading = publication.reading(async () => {
      seen.push(...(await tree(world.fleet)));
      release();
    });
    await Promise.all([applying, reading, gate]);

    expect(seen.filter(line => line.startsWith('bin/'))).toEqual([]);
  });

  it('writes a fleet document with a comparison against what it expects, and refuses a stale one', async () => {
    const world = await fleetWorld();
    const doc = join(world.fleet, 'assets', 'components', 'instructions', 'main.md');
    await mkdir(join(world.fleet, 'assets', 'components', 'instructions'), { recursive: true });
    await writeFile(doc, 'first\n');
    const digest = new Bun.CryptoHasher('sha256').update('first\n').digest('hex');
    const plan = planFor(world, []);

    await world.provisioner().apply(plan, [{ path: doc, content: 'second\n', mode: 0o600, expect: digest }]);
    expect(await readFile(doc, 'utf8')).toBe('second\n');
    expect((await stat(doc)).mode & 0o777).toBe(0o600);

    // The same expectation is now stale: applying would discard the newer version.
    const act = world.provisioner().apply(plan, [{ path: doc, content: 'third\n', mode: 0o600, expect: digest }]);
    await expect(act).rejects.toThrow(/not what this change was composed against/u);
    expect(await readFile(doc, 'utf8')).toBe('second\n');
  });

  it('prunes only managed files nothing claims, leaving a hand-written file and a link alone', async () => {
    const world = await fleetWorld();
    const bin = join(world.fleet, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'stale'), '# ferretry-managed\nexit 0\n');
    await writeFile(join(bin, 'kept'), '# ferretry-managed\nexit 0\n');
    await writeFile(join(bin, 'mine'), '#!/bin/sh\necho hand written\n');
    await symlink('/usr/bin/true', join(bin, 'linked'));

    const result = await world
      .provisioner()
      .apply(planFor(world, [{ kind: 'prune', path: bin, marker: 'ferretry-managed', keep: ['kept'] }]));

    expect((await readdir(bin)).toSorted()).toEqual(['kept', 'linked', 'mine']);
    expect(result.operationCount).toBe(1);
  });

  it('applies one plan at a time, in order', async () => {
    const world = await fleetWorld();
    const provisioner = world.provisioner();
    const first = planFor(world, [{ kind: 'file', path: join(world.fleet, 'bin', 'a'), content: '1', mode: 0o700 }]);
    const second = planFor(world, [{ kind: 'file', path: join(world.fleet, 'bin', 'a'), content: '2', mode: 0o700 }]);

    await Promise.all([provisioner.apply(first), provisioner.apply(second)]);

    expect(await readFile(join(world.fleet, 'bin', 'a'), 'utf8')).toBe('2');
  });

  it('gives a copied file the mode the plan asked for, narrowed to the owner', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'note.md'), 'note');
    const destination = join(world.fleet, 'homes', 'one', 'note.md');

    await world
      .provisioner()
      .apply(
        planFor(world, [
          { kind: 'copy', source: join(world.fleet, 'assets', 'note.md'), path: destination, mode: 0o400 },
        ]),
      );

    expect((await stat(destination)).mode & 0o777).toBe(0o400);
  });

  it('copies a folder whole and publishes it by moving it onto a free name, leaving no staged copy behind', async () => {
    const world = await fleetWorld();
    const skill = join(world.fleet, 'assets', 'skills', 'review');
    await mkdir(join(skill, 'nested'), { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: review\n---\n');
    await writeFile(join(skill, 'nested', 'a.txt'), 'a');
    await symlink('/etc/hostname', join(skill, 'link-inside'));
    // A template linked out of a read-only store arrives read-only; the copied root is made writable for its owner.
    await chmod(skill, 0o555);
    const destination = join(world.fleet, 'homes', 'one', 'skills', 'review');

    await world.provisioner().apply(planFor(world, [{ kind: 'copy', source: skill, path: destination }]));
    await chmod(skill, 0o755);

    expect((await tree(destination)).toSorted()).toEqual([
      'SKILL.md = ---\nname: review\n---\n',
      'nested/',
      'nested/a.txt = a',
    ]);
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    // A link inside a copied folder is skipped by the root, never dereferenced (declared difference).
    expect(await exists(join(destination, 'link-inside'))).toBe(false);
    expect(
      (await tree(join(world.fleet, 'homes', 'one', 'skills'))).filter(line => line.includes('.fy-fleet-')),
    ).toEqual([]);
  });
});
