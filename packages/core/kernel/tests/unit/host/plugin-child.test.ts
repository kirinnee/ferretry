import { describe, expect, spyOn, test } from 'bun:test';
import type { SpawnPort } from '../../../contract/ports.ts';
import { programName } from '../../../manifest/reach.ts';
import { NO_ITEMS, PermissionError, restrictSpawn, spawnPermitted } from '../../../host/permissions.ts';
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

describe('`$daemon` grants the daemon executable only as `--plugin-child <program>`', () => {
  const declared = ['$daemon'];
  const calls: { program: string; args: readonly string[] }[] = [];
  const base: SpawnPort = {
    run: async (program, args) => {
      calls.push({ program, args });
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
    runBytes: async () => {
      throw new Error('not run here');
    },
    start: (program, args) => {
      calls.push({ program, args });
      return { pid: 1 } as unknown as ReturnType<SpawnPort['start']>;
    },
  };

  test('a plugin holding only `$daemon` cannot run the daemon executable with any other arguments', async () => {
    calls.length = 0;
    const port = restrictSpawn('voice', declared, base);
    for (const args of [[], ['-e', 'process.exit(0)'], ['run', '/tmp/x.ts'], ['x', '--plugin-child', 'speech-host']]) {
      await expect(port.run(process.execPath, args)).rejects.toThrow(PermissionError);
      expect(() => port.start(process.execPath, args)).toThrow(PermissionError);
    }
    expect(calls).toEqual([]);
  });

  test('`--plugin-child <program> …` is admitted, and the check names no argument it refused', async () => {
    calls.length = 0;
    const port = restrictSpawn('voice', declared, base);
    await port.run(process.execPath, ['--plugin-child', 'speech-host', 'speech']);
    port.start(process.execPath, ['--plugin-child', 'speech-host', 'reply']);
    expect(calls.map(call => call.args[0])).toEqual(['--plugin-child', '--plugin-child']);
    await port.run(process.execPath, ['-e', 'SECRET_ARG']).catch((error: unknown) => {
      expect(String(error)).not.toContain('SECRET_ARG');
    });
  });

  test('a program granted by name stays free of the argument rule', async () => {
    calls.length = 0;
    await restrictSpawn('x', [programName(process.execPath)], base).run(process.execPath, ['-e', '1']);
    expect(calls).toHaveLength(1);
  });

  test('existence checks that name no arguments still see the grant', () => {
    expect(spawnPermitted(declared, NO_ITEMS, process.execPath)).toBe(true);
    expect(spawnPermitted(declared, NO_ITEMS, process.execPath, undefined, ['-e', '1'])).toBe(false);
  });
});
