import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { inspectBinaryPatch } from '../../daemon/lib/binary-patch.ts';
import { kernelCheckout } from '../../daemon/lib/checkout.ts';
import { kernelWorkingTree } from '../../daemon/lib/git-bundle.ts';
import { git, makeRepository, realKernel } from '../support/real-git.ts';

/** Synthetic malformed Git delta instructions in the actual binary-patch wire format. */
function patch(delta: Uint8Array): Uint8Array {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
  const compressed = deflateSync(delta);
  const lines: string[] = [];
  for (let offset = 0; offset < compressed.length; offset += 52) {
    const bytes = compressed.subarray(offset, offset + 52);
    let line = String.fromCharCode(bytes.length <= 26 ? 64 + bytes.length : 70 + bytes.length);
    for (let at = 0; at < bytes.length; at += 4) {
      let word = 0;
      for (let i = 0; i < 4; i++) word = word * 256 + (bytes[at + i] ?? 0);
      let encoded = '';
      for (let i = 0; i < 5; i++) {
        encoded = alphabet[word % 85] + encoded;
        word = Math.floor(word / 85);
      }
      line += encoded;
    }
    lines.push(line);
  }
  return new TextEncoder().encode(
    `diff --git a/asset.bin b/asset.bin\nindex ${'0'.repeat(40)}..${'1'.repeat(40)}\nGIT binary patch\ndelta ${delta.length}\n${lines.join('\n')}\n\n`,
  );
}

for (const [label, delta] of [
  ['unterminated variable-length integer', [128, 128, 128, 128, 128]],
  ['incomplete decoded file', [0, 1]],
] as const)
  test(`binary inspection fails closed for ${label}`, async () => {
    let inspected = false;
    await expect(
      inspectBinaryPatch(
        patch(new Uint8Array(delta)),
        async () => new Uint8Array(),
        () => {
          inspected = true;
        },
      ),
    ).rejects.toThrow('the binary patch could not be inspected safely');
    expect(inspected).toBe(false);
  });

test('binary inspection refuses mismatched quoted paths rather than attributing content to another file', async () => {
  const bytes = patch(new Uint8Array([0, 1]));
  const altered = new TextEncoder().encode(
    new TextDecoder()
      .decode(bytes)
      .replace('diff --git a/asset.bin b/asset.bin', 'diff --git "a/source.bin" "b/other.bin"'),
  );
  await expect(
    inspectBinaryPatch(
      altered,
      async () => new Uint8Array(),
      () => {},
    ),
  ).rejects.toThrow('the binary patch could not be inspected safely');
});

test('the decoded-patch scanner refuses when its read deadline expires during expansion', async () => {
  const fixture = makeRepository();
  const path = join(fixture.folder, 'asset.bin');
  writeFileSync(path, Buffer.alloc(64));
  git(fixture.folder, 'add', 'asset.bin');
  git(fixture.folder, 'commit', '-q', '-m', 'binary base');
  writeFileSync(path, Buffer.concat([Buffer.from([0]), Buffer.from('harmless binary edit')]));
  const real = realKernel();
  const original = kernelWorkingTree(real, fixture.folder);
  const changes = await original.changes(1024 * 1024);
  let afterBlob = 0;
  const tree = kernelWorkingTree(
    {
      ...real,
      clock: { ...real.clock, nowMs: () => (afterBlob === 0 || afterBlob++ === 1 ? 0 : 10_001) },
      spawn: {
        ...real.spawn,
        runBytes: async (program, args, options) => {
          const done = await real.spawn.runBytes(program, args, options);
          if (args.includes('blob')) afterBlob = 1;
          return done;
        },
      },
    },
    fixture.folder,
  );
  await expect(tree.inspect(() => {}, changes)).rejects.toThrow('expanded move exceeded its inspection limits');
});

test('checkout refuses a host without descriptor-bound directory creation before creating a quarantine', async () => {
  const fixture = makeRepository();
  const real = realKernel();
  const checkout = kernelCheckout({
    ...real,
    roots: {
      ...real.roots,
      root: (name, options) => ({ ...real.roots.root(name, options), createDirectory: undefined }),
    },
  });
  await expect(checkout.prepare({ repo: fixture.folder }, join(fixture.folder, '..', 'move'))).rejects.toThrow(
    'cannot be created with a bound identity',
  );
});
