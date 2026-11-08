import { describe, expect, test } from 'bun:test';
import {
  buildKey,
  cacheName,
  devEnvArguments,
  isLockedFlakeRef,
  packagesExpression,
  parseDevEnv,
  parseFlakeMetadata,
  splitFlakeRef,
} from '../../daemon/lib/source.ts';
import { ShellLockSchema } from '../../contract/index.ts';
import { flakeFacts, HASH_A, HASH_B, REV_A } from './support.ts';

const flakeLock = (ref = `github:me/shells/${REV_A}?narHash=x#web`) =>
  ShellLockSchema.parse({
    format: 1,
    name: 'web',
    source: { kind: 'flake', ref, rev: REV_A, narHash: HASH_A },
    resolvedAt: '2026-11-07T10:00:00.000Z',
    floating: false,
  });
const packagesLock = (packages: string[], narHash = HASH_A) =>
  ShellLockSchema.parse({
    format: 1,
    name: 'tools',
    source: { kind: 'packages', packages, nixpkgs: { rev: REV_A, narHash } },
    resolvedAt: '2026-11-07T10:00:00.000Z',
    floating: false,
  });

describe('flake references', () => {
  test('the attribute is split off at the first #', () => {
    expect(splitFlakeRef('github:me/shells#web')).toEqual({ base: 'github:me/shells', attr: 'web' });
    expect(splitFlakeRef('github:me/shells')).toEqual({ base: 'github:me/shells', attr: undefined });
  });

  test('a reference is locked only when it names a full revision', () => {
    expect(isLockedFlakeRef(`github:me/shells/${REV_A}#web`)).toBe(true);
    expect(isLockedFlakeRef(`git+https://example.com/x.git?rev=${REV_A}`)).toBe(true);
    expect(isLockedFlakeRef('github:me/shells#web')).toBe(false);
    expect(isLockedFlakeRef('github:me/shells/main')).toBe(false);
    expect(isLockedFlakeRef('github:me/shells/abc123')).toBe(false);
  });

  test('nix flake metadata is read for the locked address, revision and hash, and nothing else is trusted', () => {
    const facts = flakeFacts();
    const json = JSON.stringify({ url: facts.url, locked: { rev: facts.rev, narHash: facts.narHash, extra: 1 } });
    expect(parseFlakeMetadata(json)).toEqual({ ok: true, value: facts });
    expect(parseFlakeMetadata('not json').ok).toBe(false);
    expect(parseFlakeMetadata(JSON.stringify({ url: facts.url, locked: { narHash: facts.narHash } })).ok).toBe(false);
    expect(parseFlakeMetadata(JSON.stringify({ url: facts.url, locked: { rev: REV_A, narHash: 'md5-x' } })).ok).toBe(
      false,
    );
  });
});

describe('the environment of a shell', () => {
  const doc = (variables: Record<string, unknown>) => JSON.stringify({ bashFunctions: {}, variables });

  test('only exported strings come through, without the build sandbox’s own variables', () => {
    const result = parseDevEnv(
      doc({
        PATH: { type: 'exported', value: '/nix/store/a/bin' },
        HOME: { type: 'exported', value: '/homeless-shelter' },
        NIX_BUILD_TOP: { type: 'exported', value: '/build' },
        NIX_BUILD_CORES: { type: 'exported', value: '4' },
        buildInputs: { type: 'var', value: 'x' },
        list: { type: 'array', value: ['a'] },
        EDITOR: { type: 'exported', value: 'vi' },
      }),
    );
    expect(result).toEqual({ ok: true, value: { PATH: '/nix/store/a/bin', EDITOR: 'vi' } });
  });

  test('a shell with no PATH holds no tools and is refused', () => {
    expect(parseDevEnv(doc({ EDITOR: { type: 'exported', value: 'vi' } })).ok).toBe(false);
    expect(parseDevEnv('{}').ok).toBe(false);
  });
});

describe('building', () => {
  test('a flake is built from its locked address; a package list from its pinned nixpkgs', () => {
    expect(devEnvArguments(flakeLock('github:me/shells/x#web')).at(-1)).toBe('github:me/shells/x#web');
    const args = devEnvArguments(packagesLock(['git', 'python3Packages.pip']));
    expect(args).toContain('--expr');
    const expression = args.at(-1) as string;
    expect(expression).toContain(`github:NixOS/nixpkgs/${REV_A}?narHash=${encodeURIComponent(HASH_A)}`);
    expect(expression).toContain('"python3Packages.pip"');
  });

  test('a package name cannot break out of its quotes', () => {
    const expression = packagesExpression({ rev: REV_A, narHash: HASH_A as never }, ['a"; builtins.abort "x']);
    expect(expression).toContain('\\"');
    expect(expression).not.toContain('"a"; builtins');
  });

  test('the cache key follows the pins: same pins, same key; a different hash or package set, another', () => {
    expect(buildKey(packagesLock(['git', 'jq']))).toBe(buildKey(packagesLock(['jq', 'git'])));
    expect(buildKey(packagesLock(['git']))).not.toBe(buildKey(packagesLock(['git', 'jq'])));
    expect(buildKey(packagesLock(['git']))).not.toBe(buildKey(packagesLock(['git'], HASH_B)));
    expect(buildKey(flakeLock('a#web'))).not.toBe(buildKey(flakeLock('a#api')));
    expect(buildKey(packagesLock(['git']))).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/u);
  });

  test('a cache file name holds no character a file name cannot', () => {
    for (const packages of [['a'], ['b'], ['c'], ['d'], ['e']])
      expect(cacheName(buildKey(packagesLock(packages)))).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe('what nix answers badly', () => {
  test('metadata whose locked address is not a URL cannot be pinned, even with a prefetched hash', () => {
    const doc = JSON.stringify({ url: `not a url/${REV_A}`, locked: { rev: REV_A } });
    expect(parseFlakeMetadata(doc, HASH_A)).toEqual({ ok: false, error: 'nix named no locked address for it' });
  });

  test('a dev-env answer that is not JSON is refused in words', () => {
    expect(parseDevEnv('not json')).toEqual({ ok: false, error: 'nix did not answer in JSON' });
  });
});
