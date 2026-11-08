/**
 * The pure rules both hosts share for `linkTo`, `setMode` and `harnessFile` (`host/root-rules.ts`): which roots take a
 * link, which bits a mode keeps, and the lexical half of a harness file. Each rule here is the one the real disk tests
 * and the parity test then meet through a host.
 */
import { describe, expect, test } from 'bun:test';
import type { RootName } from '../../../contract/ports.ts';
import {
  harnessFileRefusal,
  permittedMode,
  renameNamesRefusal,
  takesLinks,
  takesRenames,
  takesUnlinks,
  unlinkNameRefusal,
} from '../../../host/root-rules.ts';

const ALL: readonly RootName[] = [
  'agent-homes',
  'harness-history',
  'worktrees',
  'work',
  'imports',
  'downloads',
  'credentials',
  'sessions',
  'fleet',
  'harness-home',
];

describe('takesLinks', () => {
  test('only fleet and agent-homes take a link', () => {
    expect(ALL.filter(takesLinks)).toEqual(['agent-homes', 'fleet']);
  });
});

describe('takesRenames', () => {
  test('only fleet and agent-homes take a rename', () => {
    expect(ALL.filter(takesRenames)).toEqual(['agent-homes', 'fleet']);
  });
});

describe('renameNamesRefusal', () => {
  test('two plain, different names are accepted', () => {
    expect(renameNamesRefusal('/r/a', '/r/b')).toBeUndefined();
  });

  test('a .. segment, a NUL, an empty name and a non-string are refused', () => {
    expect(renameNamesRefusal('/r/../a', '/r/b')).toBe('outside');
    expect(renameNamesRefusal('/r/a', '/r/x/../b')).toBe('outside');
    expect(renameNamesRefusal('/r/a\0', '/r/b')).toBe('outside');
    expect(renameNamesRefusal('/r/a', '/r/b\0')).toBe('outside');
    expect(renameNamesRefusal('', '/r/b')).toBe('outside');
    expect(renameNamesRefusal('/r/a', '')).toBe('outside');
    expect(renameNamesRefusal(undefined as unknown as string, '/r/b')).toBe('outside');
  });

  test('the same name at both ends is refused: nothing would move', () => {
    expect(renameNamesRefusal('/r/a', '/r/a')).toBe('outside');
  });
});

describe('takesUnlinks', () => {
  test('only fleet and agent-homes take an unlink', () => {
    expect(ALL.filter(takesUnlinks)).toEqual(['agent-homes', 'fleet']);
  });
});

describe('unlinkNameRefusal', () => {
  test('a plain name is accepted', () => {
    expect(unlinkNameRefusal('/r/a')).toBeUndefined();
  });

  test('a .. segment, a NUL, an empty name and a non-string are refused', () => {
    expect(unlinkNameRefusal('/r/../a')).toBe('outside');
    expect(unlinkNameRefusal('/r/a\0')).toBe('outside');
    expect(unlinkNameRefusal('')).toBe('outside');
    expect(unlinkNameRefusal(undefined as unknown as string)).toBe('outside');
  });
});

describe('permittedMode', () => {
  test('an internal root keeps 0o700 and nothing else', () => {
    expect(permittedMode(true, 0o777)).toBe(0o700);
    expect(permittedMode(true, 0o7777)).toBe(0o700);
    expect(permittedMode(true, 0o644)).toBe(0o600);
    expect(permittedMode(true, 0o500)).toBe(0o500);
    expect(permittedMode(true, 0)).toBe(0);
  });

  test('any other root keeps 0o777, never setuid, setgid or sticky', () => {
    expect(permittedMode(false, 0o4755)).toBe(0o755);
    expect(permittedMode(false, 0o2775)).toBe(0o775);
    expect(permittedMode(false, 0o1777)).toBe(0o777);
  });

  test('a mode that is not an integer in 0..0o7777 is refused', () => {
    for (const mode of [-1, 0o10000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(permittedMode(true, mode)).toBeUndefined();
  });
});

describe('harnessFileRefusal', () => {
  const ask = (overrides: Partial<Parameters<typeof harnessFileRefusal>[0]> = {}) =>
    harnessFileRefusal({
      plugin: 'runtimes',
      mayHold: true,
      roots: ['harness-home'],
      names: ['.claude.json'],
      home: '/home/me/.fyhome',
      absolutePath: '/home/me/.claude.json',
      ...overrides,
    });

  test('a declared name beside a harness home is accepted', () => {
    expect(ask()).toBeUndefined();
  });

  test('a plugin that may not hold harness-home, or did not declare it, is refused', () => {
    expect(ask({ mayHold: false })).toBe('not_declared');
    expect(ask({ roots: ['fleet'] })).toBe('not_declared');
  });

  test('names match exactly as plain names: a wildcard, a pattern or a path matches nothing', () => {
    expect(ask({ names: undefined })).toBe('not_declared');
    expect(ask({ names: [] })).toBe('not_declared');
    expect(ask({ names: ['*'] })).toBe('not_declared');
    expect(ask({ names: ['.claude*'] })).toBe('not_declared');
    expect(ask({ names: ['me/.claude.json'] })).toBe('not_declared');
    expect(ask({ names: ['.claude.json'], absolutePath: '/home/me/.claude.json.bak' })).toBe('not_declared');
    expect(ask({ names: ['..'], absolutePath: '/home/me/..' })).toBe('outside');
  });

  test('the path is absolute, normalized and has a folder', () => {
    for (const absolutePath of [
      '.claude.json',
      '/home/me/./.claude.json',
      '/home/me//.claude.json',
      '/home/x/../me/.claude.json',
      '/home/me/.claude.json/',
      '/home/me/.claude.json\0',
      '/',
    ])
      expect(ask({ absolutePath })).toBe('outside');
  });

  test('a path in the fence is refused: the home and its moved-aside folders', () => {
    expect(ask({ absolutePath: '/home/me/.fyhome/.claude.json' })).toBe('fenced');
    expect(ask({ absolutePath: '/home/me/.fyhome/config/.claude.json' })).toBe('fenced');
    expect(ask({ absolutePath: '/home/me/.fyhome-before-2026-01-01-0000/.claude.json' })).toBe('fenced');
  });
});
