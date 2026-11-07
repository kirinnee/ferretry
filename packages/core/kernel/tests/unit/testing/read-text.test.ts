import { expect, test } from 'bun:test';
import type { CliContext } from '../../../manifest/implement.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { testReadText } from '../../../testing/index.ts';

test('CLI readText is optional, decodes UTF-8, reads stdin for dash, and leaves length validation to the caller', async () => {
  const optional: {} extends Pick<CliContext<Manifest>, 'readText'> ? true : false = true;
  const read: NonNullable<CliContext<Manifest>['readText']> = testReadText(
    {
      'recipe.md': new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0xff]),
      '/absolute.md': 'plain',
      'large.md': 'x'.repeat(100_000),
      '-': 'a file called dash',
    },
    new TextEncoder().encode('標準入力'),
  );
  expect(optional).toBe(true);
  expect(await read('recipe.md')).toBe('é�');
  expect(await read('/absolute.md')).toBe('plain');
  expect(await read('-')).toBe('標準入力');
  expect((await read('large.md')).length).toBe(100_000);
  await expect(read('missing.md')).rejects.toThrow();
});
