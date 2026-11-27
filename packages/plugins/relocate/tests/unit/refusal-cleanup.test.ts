import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kernelCheckout } from '../../daemon/lib/checkout.ts';
import { kernelWorkingTree } from '../../daemon/lib/git-bundle.ts';
import { realKernel, makeRepository, git } from '../support/real-git.ts';
import { bytes, hostile } from '../support/hostile.ts';
import { targetWorld } from '../support/target.ts';
import { world } from '../support/world.ts';
import { FERRET } from '../support/fake-ferrets.ts';

test('the checkout adapter itself refuses file transport and removes only the quarantine it claimed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relocate-refusal-'));
  const folder = join(root, 'quarantine');
  await expect(kernelCheckout(realKernel()).prepare({ remote: 'file:///tmp/hostile.git' }, folder)).rejects.toThrow(
    'only an approved https or ssh',
  );
  expect(existsSync(folder)).toBe(false);
});

test('an existing project object directory with alternate-list separators is refused and cleaned', async () => {
  const fixture = makeRepository();
  const kernel = realKernel();
  const run = kernel.spawn.runBytes;
  const checkout = kernelCheckout({
    ...kernel,
    spawn: {
      ...kernel.spawn,
      runBytes: async (program, args, options) => {
        const done = await run(program, args, options);
        return args.includes('rev-parse') ? { ...done, stdout: bytes('/tmp/project:outside/objects\n') } : done;
      },
    },
  });
  const folder = join(fixture.folder, '..', 'quarantine');
  await expect(checkout.prepare({ repo: fixture.folder }, folder)).rejects.toThrow('objects cannot be borrowed safely');
  expect(existsSync(folder)).toBe(false);
});

test('failed quarantine preparation reports a failed identity-bound cleanup and keeps the directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relocate-cleanup-'));
  const folder = join(root, 'quarantine');
  const kernel = realKernel();
  let quarantine = '';
  const checkout = kernelCheckout({
    ...kernel,
    roots: {
      ...kernel.roots,
      root: (name, options) => ({
        ...kernel.roots.root(name, options),
        createDirectory: async path => {
          quarantine = path;
          const create = kernel.roots.root(name, options).createDirectory;
          if (create === undefined) throw new Error('missing creating handle');
          return await create(path);
        },
        remove: async () => {
          throw new Error('injected cleanup failure');
        },
      }),
    },
  });
  await expect(checkout.prepare({ remote: 'file:///tmp/hostile.git' }, folder)).rejects.toThrow('cleanup failed');
  expect(existsSync(quarantine)).toBe(true);
});

test('expanded-history inspection refuses an excessive object list before reading any object', async () => {
  const fixture = makeRepository();
  const kernel = realKernel();
  const run = kernel.spawn.runBytes;
  let objectsRead = 0;
  const tree = kernelWorkingTree(
    {
      ...kernel,
      spawn: {
        ...kernel.spawn,
        runBytes: async (program, args, options) => {
          if (args.includes('cat-file')) objectsRead++;
          const done = await run(program, args, options);
          return args.includes('rev-list')
            ? { ...done, stdout: bytes(Array.from({ length: 20_001 }, () => 'a'.repeat(40)).join('\n')) }
            : done;
        },
      },
    },
    fixture.folder,
  );
  await expect(tree.inspect(() => {})).rejects.toThrow('too many objects');
  expect(objectsRead).toBe(0);
});

for (const unavailable of ['missing-inspector', 'unreadable-vault'] as const)
  test(`export refuses ${unavailable}, masks the diagnosis and recovers the stopped source`, async () => {
    const w = await world({
      redaction: {
        read: async work => {
          if (unavailable === 'unreadable-vault') throw new Error('private diagnostic must not leave');
          return await work({ text: text => text, cells: grid => grid, lines: lines => lines });
        },
      },
    });
    await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toMatchObject({
      code: 'secret_check_failed',
      message: 'the daemon could not inspect the move for known secret values',
    });
    expect(w.ferrets.calls).toEqual(['stop:polite', 'resume']);
  });

test('a chained symlink in a signed bundle is refused before checkout or start', async () => {
  const fixture = makeRepository();
  const target = await targetWorld({}, fixture.remote);
  const patch = ['first', 'second']
    .map(
      (name, i) =>
        `diff --git a/${name} b/${name}\nnew file mode 120000\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${i === 0 ? 'second' : 'README.md'}\n\\ No newline at end of file\n`,
    )
    .join('');
  const made = await hostile(target, {
    head: git(target.repo, 'rev-parse', 'HEAD').trim(),
    extra: [{ kind: 'worktree-changes', path: 'changes.diff', bytes: bytes(patch) }],
  });
  const before = target.shape();
  await expect(target.importer.import(made.offerId, made.request)).rejects.toThrow('chained moved symlinks');
  expect(target.started.length).toBe(0);
  expect(target.shape()).toEqual(before);
});
