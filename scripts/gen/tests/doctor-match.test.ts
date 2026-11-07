/** `manifest-match` and the manifest's `doctor` ids: each declared id needs a check function in the daemon half. */
import { describe, expect, test } from 'bun:test';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import { halfFindings } from '../lib/halves.ts';
import type { AnyImplementation } from '../lib/workspace.ts';

const manifest = { id: 'alpha', title: 'Alpha', version: '5.0.0', api: 5, doctor: ['alpha-ok'] } as unknown as Manifest;
const daemon = (half: object): AnyImplementation =>
  ({ half: 'daemon', manifest, build: () => half }) as unknown as AnyImplementation;
const messages = (half: object): string[] =>
  halfFindings('packages/plugins/alpha/daemon', manifest, 'daemon', daemon(half), false).map(f => f.message);

describe('manifest-match: doctor checks', () => {
  test('a declared doctor id with its function passes', () => {
    expect(messages({ doctor: { 'alpha-ok': async () => ({ state: 'ok', detail: 'fine' }) } })).toEqual([]);
  });
  test('planted: a declared doctor id with no function, and an undeclared one', () => {
    expect(messages({})).toEqual(['daemon half misses doctor "alpha-ok"']);
    expect(messages({ doctor: { 'alpha-ok': async () => ({}), 'alpha-extra': async () => ({}) } })).toEqual([
      'daemon half implements undeclared doctor "alpha-extra"',
    ]);
  });
});

describe('manifest-match: network resolvers', () => {
  const withResolver = {
    id: 'relayish',
    title: 'R',
    version: '5.0.0',
    api: 5,
    permissions: { network: ['a.test', { resolver: 'relay' }] },
  } as unknown as Manifest;
  const findings = (half: object): string[] =>
    halfFindings(
      'packages/plugins/relayish/daemon',
      withResolver,
      'daemon',
      { half: 'daemon', manifest: withResolver, build: () => half } as unknown as AnyImplementation,
      false,
    ).map(f => f.message);
  test('a declared resolver needs its function; an undeclared one is refused', () => {
    expect(findings({ resolvers: { relay: () => [] } })).toEqual([]);
    expect(findings({})).toEqual(['daemon half misses resolvers "relay"']);
    expect(findings({ resolvers: { relay: () => [], other: () => [] } })).toEqual([
      'daemon half implements undeclared resolvers "other"',
    ]);
  });
});
