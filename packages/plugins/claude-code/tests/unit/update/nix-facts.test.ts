import { describe, expect, test } from 'bun:test';
import {
  nixStorePaths,
  parseNixProfileList,
  passesThroughHomeManagerPath,
  symlinkHops,
} from '../../../daemon/lib/update/nix-facts.ts';

const store = (hash: string, name: string): string => `/nix/store/${hash.repeat(32)}-${name}`;
const CLAUDE = store('a', 'claude-code-2.1.220');
const HOME_MANAGER = store('b', 'home-manager-path');
const OTHER = store('c', 'ripgrep-14');

describe('the profile element that holds an executable', () => {
  test('reads Nix 3’s profile, whose elements are keyed by name, and names the one whose store path holds the executable', () => {
    const profile = {
      version: 3,
      elements: { ripgrep: { storePaths: [OTHER] }, 'claude-code': { storePaths: [CLAUDE] } },
    };
    expect(parseNixProfileList(profile, [`${CLAUDE}/bin/claude`])).toEqual({
      element: 'claude-code',
      homeManager: false,
    });
  });

  test('reads Nix 2’s profile, an array whose index is the element’s name', () => {
    const profile = { version: 2, elements: [{ storePaths: [OTHER] }, { storePaths: [CLAUDE] }] };
    expect(parseNixProfileList(profile, [CLAUDE])).toEqual({ element: '1', homeManager: false });
  });

  test('never calls the home-manager generation the element, and reports it as home-manager’s', () => {
    const profile = {
      version: 3,
      elements: { 'home-manager-path': { storePaths: [CLAUDE] }, other: { storePaths: [HOME_MANAGER, CLAUDE] } },
    };
    expect(parseNixProfileList(profile, [CLAUDE])).toEqual({ element: undefined, homeManager: true });
  });

  test('answers no element for an executable no element holds, and for an element with no store paths', () => {
    const profile = { version: 3, elements: { empty: {}, ripgrep: { storePaths: [OTHER] } } };
    expect(parseNixProfileList(profile, [CLAUDE])).toEqual({ element: undefined, homeManager: false });
  });

  test('guesses nothing from something that is not a profile', () => {
    for (const nonsense of [undefined, null, 'elements', 3, {}, { elements: 'many' }, { elements: [7] }])
      expect(parseNixProfileList(nonsense, [CLAUDE])).toEqual({ homeManager: false });
  });
});

/** A filesystem of links: a path is a link when the table says so, and anything else is not one. */
const links = (table: Readonly<Record<string, string>>) => async (path: string) => table[path];

describe('the links between a launched path and the file it runs', () => {
  test('lists each link met on the way, as an absolute target, following a relative one from where it sits', async () => {
    const readLink = links({
      '/usr/local/bin/claude': '../lib/claude/bin/claude',
      '/usr/local/lib/claude/bin/claude': CLAUDE,
    });
    expect(await symlinkHops('/usr/local/bin/claude', readLink)).toEqual([
      '/usr/local/bin/../lib/claude/bin/claude',
      CLAUDE,
    ]);
  });

  test('follows a link on a directory part of the path, not only on the file', async () => {
    const readLink = links({ '/opt/tools': '/nix/profile/bin' });
    expect(await symlinkHops('/opt/tools/claude', readLink)).toEqual(['/nix/profile/bin']);
  });

  test('walks a path with dot and dot-dot parts, and a path that is not a link at all', async () => {
    expect(await symlinkHops('/a/./b/../claude', links({}))).toEqual([]);
    expect(await symlinkHops('/a/../../claude', links({}))).toEqual([]);
    const readLink = links({ '/claude': '/real/claude' });
    expect(await symlinkHops('/a/b/../../claude', readLink)).toEqual(['/real/claude']);
  });

  test('ends a loop of links at the kernel’s limit instead of spinning', async () => {
    const hops = await symlinkHops('/loop', links({ '/loop': '/loop' }));
    expect(hops.length).toBe(40);
    expect(new Set(hops)).toEqual(new Set(['/loop']));
  });
});

describe('what a link chain leads through', () => {
  test('keeps the store paths, in order, and drops everything else', () => {
    expect(nixStorePaths(['/usr/bin/claude', CLAUDE, '/home/me/.nix-profile/bin', OTHER, '/nix/store/short'])).toEqual([
      CLAUDE,
      OTHER,
    ]);
  });

  test('knows home-manager’s own generation, at the path or beneath it, and nothing that merely mentions it', () => {
    expect(passesThroughHomeManagerPath([OTHER, `${HOME_MANAGER}/bin/claude`])).toBe(true);
    expect(passesThroughHomeManagerPath([HOME_MANAGER])).toBe(true);
    expect(passesThroughHomeManagerPath([OTHER, '/home/me/home-manager-path'])).toBe(false);
    expect(passesThroughHomeManagerPath([store('d', 'home-manager-path-extra')])).toBe(false);
  });
});
