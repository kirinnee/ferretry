import { describe, expect, spyOn, test } from 'bun:test';
import { spawnPermitted, NO_ITEMS } from '../../../host/permissions.ts';
import { runPluginChild } from '../../../host/plugin-child.ts';

describe("`fyd --plugin-child`: a plugin's child is a program, never a second daemon", () => {
  test('only a bare name of a declared worker program is run: paths, specifiers and unknown names are refused with usage', async () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      for (const stem of [
        undefined,
        '',
        '../x',
        '/etc/passwd',
        './speech-host',
        'node:fs',
        'speech-host.js',
        'Speech',
        'no-such-program',
      ])
        expect(await runPluginChild(stem === undefined ? [] : [stem])).toBe(64);
    } finally {
      spy.mockRestore();
    }
    expect(written.every(line => line.includes('is not a program a plugin declared'))).toBe(true);
  });
});

describe('`$daemon` in permissions.spawn', () => {
  const declared = ['$daemon'];
  test("allows this process's own executable, exactly, and nothing else", () => {
    expect(spawnPermitted(declared, NO_ITEMS, process.execPath)).toBe(true);
    for (const other of ['/usr/bin/bun', 'bun', '$daemon', `${process.execPath}x`, '/tmp/fyd', 'sh'])
      expect(spawnPermitted(declared, NO_ITEMS, other)).toBe(false);
  });

  test('a plugin that does not declare it may not run the executable', () => {
    expect(spawnPermitted(['git'], NO_ITEMS, process.execPath)).toBe(false);
    expect(spawnPermitted([], NO_ITEMS, process.execPath)).toBe(false);
  });
});
