import { expect, test } from 'bun:test';
import { VaultRedaction } from '../../../../daemon/lib/secrets/read-scope.ts';
import type { RedactionScope } from '@ferretry/kernel/contract';

test('outbound byte inspection returns only names, handles binary/UTF-8 and revokes with its scope', async () => {
  const redactor = new VaultRedaction({
    values: async () =>
      new Map([
        ['TOKEN', 'fixture-私-key'],
        ['EMPTY', ''],
      ]),
  });
  let escaped: RedactionScope | undefined;
  await redactor.read(scope => {
    escaped = scope;
    const raw = new Uint8Array([255, ...new TextEncoder().encode('before fixture-私-key after'), 0]);
    expect(scope.secretNamesIn?.(raw)).toEqual(['TOKEN']);
    expect(scope.secretNamesIn?.(new TextEncoder().encode('ordinary transcript'))).toEqual([]);
  });
  expect(() => escaped?.secretNamesIn?.(new Uint8Array())).toThrow('after the read');
});

test('an unreadable vault refuses before any transfer inspection can run', async () => {
  let called = false;
  const redactor = new VaultRedaction({
    values: async () => {
      throw new Error('unavailable');
    },
  });
  await expect(
    redactor.read(() => {
      called = true;
    }),
  ).rejects.toThrow('unavailable');
  expect(called).toBe(false);
});
