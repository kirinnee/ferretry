/** `manifest-match` and the daemon half's `beforeListen`: the host calls it once per boot; it is not a section. */
import { describe, expect, test } from 'bun:test';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import { halfFindings } from '../lib/halves.ts';
import type { AnyImplementation } from '../lib/workspace.ts';

const manifest = { id: 'alpha', title: 'Alpha', version: '5.0.0', api: 5 } as unknown as Manifest;
const messages = (half: object, name: 'daemon' | 'cli' = 'daemon'): string[] =>
  halfFindings(
    'packages/plugins/alpha/daemon',
    manifest,
    name,
    { half: name, manifest, build: () => half } as unknown as AnyImplementation,
    false,
  ).map(f => f.message);

describe('manifest-match: beforeListen', () => {
  test('a daemon half with a beforeListen function is not an unknown section', () => {
    expect(messages({ beforeListen: async () => {} })).toEqual([]);
  });
  test('any other stray member is still an unknown section', () => {
    expect(messages({ beforeListen: async () => {}, afterListen: async () => {} })).toEqual([
      'daemon half returns unknown section "afterListen"',
    ]);
  });
  test('only the daemon half may carry it', () => {
    expect(messages({ beforeListen: async () => {} }, 'cli')).toEqual([
      'cli half returns unknown section "beforeListen"',
    ]);
  });
});
