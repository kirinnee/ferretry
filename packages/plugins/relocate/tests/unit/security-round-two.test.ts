import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kernelCheckout } from '../../daemon/lib/checkout.ts';
import { kernelWorkingTree } from '../../daemon/lib/git-bundle.ts';
import { FERRET } from '../support/fake-ferrets.ts';
import { hostile } from '../support/hostile.ts';
import { git, makeRepository, realKernel, snapshotOf } from '../support/real-git.ts';
import { targetWorld } from '../support/target.ts';
import { world } from '../support/world.ts';

test('R2-1 original symlink components refuse a signed bundle before any launch or persistent write', async () => {
  const fixture = makeRepository();
  mkdirSync(join(fixture.folder, 'nested'));
  symlinkSync('.', join(fixture.folder, 'nested/sub'));
  symlinkSync('sub/../../outside', join(fixture.folder, 'nested/x'));
  git(fixture.folder, 'add', 'nested');
  git(fixture.folder, 'commit', '-q', '-m', 'intermediate symlink attack');
  const head = git(fixture.folder, 'rev-parse', 'HEAD').trim();
  const pack = join(fixture.folder, '..', 'attack.bundle');
  git(fixture.folder, 'bundle', 'create', pack, 'HEAD');
  const target = await targetWorld({}, fixture.remote);
  const before = target.shape();
  const made = await hostile(target, {
    head,
    extra: [{ kind: 'worktree-commits', path: 'commits.bundle', bytes: new Uint8Array(readFileSync(pack)) }],
  });
  let refused = false;
  try {
    await target.importer.import(made.offerId, made.request);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
  expect(target.started.length).toBe(0);
  expect(target.shape()).toEqual(before);
  expect(readdirSync(join(target.root, 'managed-worktrees'))).toEqual([]);
});

test('R2-2 a quarantine swapped after creation survives forced preparation failure byte-identical', async () => {
  const fixture = makeRepository();
  const kernel = realKernel();
  let swapped = '';
  let before = '';
  const swap = (folder: string) => {
    if (swapped !== '') return;
    renameSync(folder, `${folder}-original`);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, 'other-owner.bin'), Buffer.from([0, 1, 2, 255]));
    swapped = folder;
    before = JSON.stringify([...snapshotOf(folder)]);
  };
  const run = kernel.spawn.runBytes;
  const checkout = kernelCheckout({
    ...kernel,
    roots: {
      ...kernel.roots,
      root: (name, options) => {
        const root = kernel.roots.root(name, options);
        return {
          ...root,
          createDirectory: async path => {
            const create = root.createDirectory;
            if (create === undefined) throw new Error('missing creating handle');
            const identity = await create(path);
            swap(path);
            return identity;
          },
        };
      },
    },
    spawn: {
      ...kernel.spawn,
      runBytes: async (program, args, options) => {
        if (program === 'git') throw new Error('forced failure after directory creation');
        const done = await run(program, args, options);
        if (program === 'mkdir' && done.exitCode === 0) {
          const cwd = typeof options?.cwd === 'string' ? options.cwd : options?.cwd?.describe;
          swap(join(cwd as string, args.at(-1) as string));
        }
        return done;
      },
    },
  });

  await expect(
    checkout.prepare({ repo: fixture.folder }, join(fixture.folder, '..', 'quarantine')),
  ).rejects.toBeDefined();
  expect(swapped !== '').toBe(true);
  expect(existsSync(swapped)).toBe(true);
  expect(existsSync(swapped) && JSON.stringify([...snapshotOf(swapped)]) === before).toBe(true);
  expect(readFileSync(join(swapped, 'other-owner.bin')).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
});

test('binary inspection expands the captured patch even after the working file changes', async () => {
  const fixture = makeRepository();
  const path = join(fixture.folder, 'captured "binary".bin');
  const base = Buffer.alloc(32_768, 73);
  base[0] = 0;
  writeFileSync(path, base);
  git(fixture.folder, 'add', 'captured "binary".bin');
  git(fixture.folder, 'commit', '-q', '-m', 'captured binary base');
  const edited = Buffer.from(base);
  edited.set(Buffer.from('a harmless uncommitted change'), 1);
  writeFileSync(path, edited);
  const tree = kernelWorkingTree(realKernel(), fixture.folder);
  const patch = await tree.changes(1024 * 1024);
  writeFileSync(path, base);
  const inspected: Uint8Array[] = [];
  await tree.inspect((name, bytes) => {
    if (name === 'captured "binary".bin') inspected.push(bytes);
  }, patch);
  expect(Buffer.from(inspected.at(-2) ?? []).equals(edited)).toBe(true);
  expect(Buffer.from(inspected.at(-1) ?? []).equals(base)).toBe(true);
});

for (const kind of ['literal', 'delta'] as const)
  test(`R2-3 exact binary ${kind} carrying a known secret refuses export with only its name and file`, async () => {
    const known = 'SYNTHETIC-ONLY-BINARY-RELOCATE-R2';
    const w = await world({ knownSecrets: new Map([['BINARY_TOKEN', known]]) });
    const path = join(w.fixture.folder, 'asset.bin');
    const old = kind === 'literal' ? Buffer.alloc(64) : Buffer.alloc(32_768, 73);
    old[0] = 0;
    writeFileSync(path, old);
    git(w.fixture.folder, 'add', 'asset.bin');
    git(w.fixture.folder, 'commit', '-q', '-m', 'binary base without private content');
    const edited = Buffer.from(old);
    edited.set(Buffer.from(known), 1);
    writeFileSync(path, edited);
    const patch = git(w.fixture.folder, 'diff', '--binary', 'HEAD', '--', 'asset.bin');
    expect(patch.includes(`\n${kind} `)).toBe(true);
    expect(patch.includes(known)).toBe(false);
    let error: unknown;
    try {
      await w.relocation.export(FERRET, (await w.offer()).offer);
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    const message = error instanceof Error ? error.message : '';
    expect(message.includes(known)).toBe(false);
    expect(message.includes('BINARY_TOKEN')).toBe(true);
    expect(message.includes('asset.bin')).toBe(true);
    expect(w.ferrets.state).toBe('idle');
  });
