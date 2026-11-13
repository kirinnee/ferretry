/** `manifest-match` and the `fyd --check` seams (R689): preflight, selftest and workers sit beside `build`. */
import { describe, expect, test } from 'bun:test';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import { halfFindings } from '../lib/halves.ts';
import type { AnyImplementation } from '../lib/workspace.ts';

const manifest = {
  id: 'alpha',
  title: 'Alpha',
  version: '5.0.0',
  api: 5,
  preflight: ['lines'],
  selftest: ['engine'],
  workers: ['thread'],
} as unknown as Manifest;
const messages = (seams: object): string[] =>
  halfFindings(
    'packages/plugins/alpha/daemon',
    manifest,
    'daemon',
    { half: 'daemon', manifest, build: () => ({}), ...seams } as unknown as AnyImplementation,
    false,
  ).map(f => f.message);

describe('manifest-match: the fyd --check seams', () => {
  test('R689 a half implementing every declared preflight, selftest and worker has no finding', () => {
    expect(
      messages({
        preflight: { lines: () => [] },
        selftest: { engine: {} },
        workers: { thread: new URL('file:///w.ts') },
      }),
    ).toEqual([]);
  });
  test('R689 a declared id with no implementation is a finding, per seam', () => {
    expect(messages({})).toEqual([
      'daemon half misses preflight "lines"',
      'daemon half misses selftest "engine"',
      'daemon half misses workers "thread"',
    ]);
  });
  test('R689 an implementation of an undeclared id is a finding', () => {
    expect(
      messages({
        preflight: { lines: () => [], extra: () => [] },
        selftest: { engine: {}, other: {} },
        workers: { thread: new URL('file:///w.ts'), more: new URL('file:///m.ts') },
      }),
    ).toEqual([
      'daemon half implements undeclared preflight "extra"',
      'daemon half implements undeclared selftest "other"',
      'daemon half implements undeclared workers "more"',
    ]);
  });

  test('R689 a selftest switched by its OWN config file def has no finding; any other def is one', () => {
    const own = { kind: 'config', shape: 'file', file: 'alpha.yaml' };
    const lookalike = { ...own };
    const collection = { kind: 'config', shape: 'collection', collection: 'alpha' };
    const withConfig = { ...manifest, data: { config: [own, collection] } } as unknown as Manifest;
    const found = (def: object): string[] =>
      halfFindings(
        'packages/plugins/alpha/daemon',
        withConfig,
        'daemon',
        {
          half: 'daemon',
          manifest: withConfig,
          build: () => ({}),
          preflight: { lines: () => [] },
          selftest: { engine: { enabledBy: { def, on: () => true } } },
          workers: { thread: new URL('file:///w.ts') },
        } as unknown as AnyImplementation,
        false,
      ).map(f => f.message);
    expect(found(own)).toEqual([]);
    for (const def of [lookalike, collection])
      expect(found(def)).toEqual([
        'daemon half\'s selftest "engine" is switched by a config file that is not one of its own declared files',
      ]);
  });
});
