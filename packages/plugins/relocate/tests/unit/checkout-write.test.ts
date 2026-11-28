/** U16: the moved files are written below the quarantine this import prepared, through the kernel's writable root. */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kernelCheckout } from '../../daemon/lib/checkout.ts';
import { realKernel, makeRepository } from '../support/real-git.ts';
import { bytes } from '../support/hostile.ts';

test('a new file at the top of the tree and one in a new folder are written, and a second write of a name is refused', async () => {
  const fixture = makeRepository();
  const checkout = kernelCheckout(realKernel());
  const folder = join(mkdtempSync(join(tmpdir(), 'relocate-write-')), 'quarantine');
  const stage = await checkout.prepare({ repo: fixture.folder }, folder);
  try {
    await checkout.writeNewFile(stage.folder, 'top.txt', bytes('top'));
    await checkout.writeNewFile(stage.folder, 'deep/er/file.txt', bytes('deep'));
    expect(readFileSync(join(stage.folder, 'top.txt'), 'utf8')).toBe('top');
    expect(readFileSync(join(stage.folder, 'deep/er/file.txt'), 'utf8')).toBe('deep');
    await expect(checkout.writeNewFile(stage.folder, 'top.txt', bytes('again'))).rejects.toThrow();
    expect(readFileSync(join(stage.folder, 'top.txt'), 'utf8')).toBe('top');
  } finally {
    await stage.cleanup();
  }
  expect(existsSync(folder)).toBe(false);
});

test('a file whose folder cannot be fenced is refused, and so is a tree this import did not prepare', async () => {
  const fixture = makeRepository();
  const kernel = realKernel();
  const checkout = kernelCheckout({
    ...kernel,
    roots: {
      ...kernel.roots,
      root: (name, options) => {
        const base = kernel.roots.root(name, options);
        return {
          ...base,
          resolve: (path: string) => (path.endsWith('/sub') ? ({ ok: false } as never) : base.resolve(path)),
        };
      },
    },
  });
  const folder = join(mkdtempSync(join(tmpdir(), 'relocate-write-')), 'quarantine');
  const stage = await checkout.prepare({ repo: fixture.folder }, folder);
  try {
    await expect(checkout.writeNewFile(stage.folder, 'sub/file.txt', bytes('x'))).rejects.toThrow(
      'outside its working tree',
    );
    await expect(checkout.writeNewFile('/tmp/not-prepared', 'file.txt', bytes('x'))).rejects.toThrow(
      'not one this import prepared',
    );
  } finally {
    await stage.cleanup();
  }
});
