/**
 * `SpawnOptions.detached` (kernel batch #15): a child that outlives the daemon is new authority, so it is bounded
 * before anything starts (`host/detached.ts`), only `allowDetachedSpawn` offers it (every other spawn wrapper refuses
 * it), and the adapter starts it in its own process group with every stream ignored and unreferenced.
 */
import { describe, expect, test } from 'bun:test';
import type { ChildEnvironment, FencedPath } from '../../../contract/bound.ts';
import type { PinnedWorkingDirectory } from '../../../contract/pinned.ts';
import type { ChildHandle, SpawnOptions, SpawnPort } from '../../../contract/ports.ts';
import type { FerretId } from '../../../contract/ids.ts';
import { bunSpawn, type DetachedSpawnCall, startDetached } from '../../../host/adapters/process.ts';
import { detachedHandle, detachedNames, detachedRefusal, plainEnvironment } from '../../../host/detached.ts';
import { allowDetachedSpawn, PermissionError, restrictSpawn } from '../../../host/permissions.ts';

interface Started {
  readonly program: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions | undefined;
}

/** A spawn port that records every call and starts nothing. */
function recording(pid = 4321): SpawnPort & { readonly started: Started[]; readonly ran: Started[] } {
  const started: Started[] = [];
  const ran: Started[] = [];
  return {
    started,
    ran,
    run: async (program, args, options) => {
      ran.push({ program, args, options });
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
    runBytes: async (program, args, options) => {
      ran.push({ program, args, options });
      return {
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      };
    },
    start: (program, args, options): ChildHandle => {
      started.push({ program, args, options });
      return detachedHandle(pid);
    },
  };
}

const SPAWN = ['xdg-open', 'open', 'chrome'] as const;

/** Browsers as it declares the opener: spawnable, and detached by name. */
function browsers(detached: readonly string[] = ['xdg-open', 'open']) {
  const base = recording();
  const restricted = restrictSpawn('browsers', SPAWN, base);
  const heard: (readonly [string, number])[] = [];
  const port = allowDetachedSpawn('browsers', detached, SPAWN, restricted, base, undefined, (program, pid) =>
    heard.push([program, pid]),
  );
  return { base, port, heard };
}

const URL_WITH_QUERY = 'https://example.com/a?token=planted-query-value';

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PermissionError);
    return (error as Error).message;
  }
  throw new Error('it was not refused');
};

const handleLike = (): ChildEnvironment =>
  Object.freeze({ names: ['API_KEY'], toJSON: () => ({ names: ['API_KEY'] }) }) as unknown as ChildEnvironment;

describe('detached spawn: who may start one', () => {
  test('a declared program starts on the base adapter with detached kept, and only its name and pid are heard', () => {
    const { base, port, heard } = browsers();
    const handle = port.start('xdg-open', [URL_WITH_QUERY], { detached: true, env: { DISPLAY: ':0' } });
    expect(handle.pid).toBe(4321);
    expect(base.started).toEqual([
      { program: 'xdg-open', args: [URL_WITH_QUERY], options: { detached: true, env: { DISPLAY: ':0' } } },
    ]);
    expect(heard).toEqual([['xdg-open', 4321]]);
    expect(JSON.stringify(heard)).not.toContain('planted-query-value');
  });

  test('an absolute path to a declared name passes, as permissions.spawn matches it, and the log hears the basename', () => {
    const { base, port, heard } = browsers();
    port.start('/usr/bin/xdg-open', [URL_WITH_QUERY], { detached: true });
    expect(base.started).toHaveLength(1);
    expect(heard).toEqual([['xdg-open', 4321]]);
  });

  test('a program in permissions.spawn but not in permissions.detached is refused, and nothing starts', () => {
    const { base, port } = browsers();
    expect(refusal(() => port.start('chrome', [], { detached: true }))).toBe(
      'browsers may not start chrome detached: its manifest does not declare it in permissions.detached and permissions.spawn.',
    );
    expect(base.started).toEqual([]);
  });

  test('a program in permissions.detached but not in permissions.spawn is refused (detached is a subset)', () => {
    const { base, port } = browsers(['xdg-open', 'rundll32']);
    expect(refusal(() => port.start('rundll32', [], { detached: true }))).toContain('may not start rundll32 detached');
    expect(base.started).toEqual([]);
  });

  test('absent permissions.detached refuses every detached start', () => {
    const base = recording();
    const port = allowDetachedSpawn('browsers', undefined, SPAWN, restrictSpawn('browsers', SPAWN, base), base);
    expect(refusal(() => port.start('xdg-open', [], { detached: true }))).toContain('may not start xdg-open detached');
    expect(base.started).toEqual([]);
  });

  test("'*' and every pattern in permissions.detached name no program", () => {
    expect(detachedNames(['*', 'xdg-*', 'open', 7, { items: 'mcp' }])).toEqual(['open']);
    const { base, port } = browsers(['*']);
    expect(refusal(() => port.start('xdg-open', [], { detached: true }))).toContain('detached');
    expect(base.started).toEqual([]);
  });

  test("'*' names nothing for a core piece either, though its '*' in spawn survives", () => {
    const base = recording();
    const port = allowDetachedSpawn('ferrets', ['*'], ['*'], restrictSpawn('ferrets', ['*'], base), base);
    expect(refusal(() => port.start('anything', [], { detached: true }))).toContain('detached');
    expect(base.started).toEqual([]);
  });

  test('run and runBytes with detached are refused before anything runs', async () => {
    const { base, port } = browsers();
    await expect(port.run('xdg-open', [], { detached: true })).rejects.toThrow(
      'browsers may start a detached child only with start: run waits for the child, and a detached one is never waited on.',
    );
    await expect(port.runBytes('xdg-open', [], { detached: true })).rejects.toThrow(
      'only with start: runBytes waits for the child',
    );
    expect(base.ran).toEqual([]);
    expect(base.started).toEqual([]);
  });

  test('a call without detached goes through the restricted port unchanged', async () => {
    const { base, port, heard } = browsers();
    port.start('chrome', ['--headless'], { extraPipes: 2 });
    await port.run('xdg-open', ['x']);
    expect(base.started).toEqual([{ program: 'chrome', args: ['--headless'], options: { extraPipes: 2 } }]);
    expect(base.ran).toHaveLength(1);
    expect(heard).toEqual([]);
    expect(refusal(() => port.start('sh', ['-c', 'x']))).toContain('its manifest does not declare it');
  });
});

describe('detached spawn: only an exact true detaches', () => {
  test('detached: false is neither read as a detached start nor as an ordinary one: it is refused, and nothing starts', async () => {
    const { base, port } = browsers();
    const asked = { detached: false } as unknown as SpawnOptions;
    expect(() => port.start('xdg-open', ['x'], asked)).toThrow('true or absent');
    await expect(port.run('xdg-open', ['x'], asked)).rejects.toThrow('true or absent');
    expect(base.started).toEqual([]);
    expect(base.ran).toEqual([]);
  });
});

describe('detached spawn: each refused combination', () => {
  const pin = { install: () => () => undefined } as unknown as PinnedWorkingDirectory;
  const combos: readonly (readonly [string, SpawnOptions, string])[] = [
    ['forFerret', { detached: true, forFerret: 'f-1' as FerretId }, "would escape the ferret's limits"],
    ['extraPipes', { detached: true, extraPipes: 2 }, 'with extra pipes'],
    ['extraPipes 0', { detached: true, extraPipes: 0 }, 'with extra pipes'],
    ['stdin', { detached: true, stdin: '' }, 'with stdin'],
    ['stdin bytes', { detached: true, stdin: new Uint8Array() }, 'with stdin'],
    ['a pinned cwd', { detached: true, cwd: pin }, 'in a held-open folder'],
    ['timeout', { detached: true, timeout: 5_000 as SpawnOptions['timeout'] }, 'with a timeout or an abort signal'],
    ['signal', { detached: true, signal: new AbortController().signal }, 'with a timeout or an abort signal'],
    ['a Vault handle', { detached: true, env: handleLike() }, 'no secret may outlive the daemon in an orphan'],
    [
      'a non-plain env',
      { detached: true, env: Object.assign(Object.create(null), { A: 'b' }) as Record<string, string> },
      'with a secret environment',
    ],
    [
      'a non-string value',
      { detached: true, env: { A: 1 } as unknown as Record<string, string> },
      'secret environment',
    ],
  ];

  for (const [name, options, sentence] of combos)
    test(`${name} is refused before anything starts`, () => {
      const { base, port, heard } = browsers();
      expect(refusal(() => port.start('xdg-open', [URL_WITH_QUERY], options))).toContain(sentence);
      expect(base.started).toEqual([]);
      expect(heard).toEqual([]);
    });

  test('a fenced string cwd and a plain env are allowed', () => {
    const { base, port } = browsers();
    port.start('xdg-open', [], { detached: true, cwd: '/tmp/x' as FencedPath, env: { PATH: '/bin' } });
    expect(base.started).toHaveLength(1);
  });

  test('plainEnvironment: only an object literal of strings', () => {
    expect(plainEnvironment({ A: 'b' })).toBe(true);
    expect(plainEnvironment({})).toBe(true);
    expect(plainEnvironment(handleLike())).toBe(false);
    expect(plainEnvironment(null)).toBe(false);
    expect(plainEnvironment('A=b')).toBe(false);
    expect(plainEnvironment(Object.create(null))).toBe(false);
  });

  test('the rule is total: the first refusal in order wins, and an allowed start answers undefined', () => {
    expect(detachedRefusal('p', ['x'], true, 'start', 'x', { detached: true })).toBeUndefined();
    expect(detachedRefusal('p', ['x'], true, 'run', 'x', { detached: true, stdin: '' })).toContain('only with start');
    expect(detachedRefusal('p', [], true, 'start', 'x', { detached: true, stdin: '' })).toContain('does not declare');
  });
});

describe('detached spawn: every other spawn wrapper refuses it', () => {
  test('restrictSpawn alone refuses detached, even for a declared program, on start, run and runBytes', async () => {
    const base = recording();
    const port = restrictSpawn('browsers', SPAWN, base);
    expect(refusal(() => port.start('xdg-open', [], { detached: true }))).toBe(
      'browsers may not start xdg-open detached through this port.',
    );
    await expect(port.run('xdg-open', [], { detached: true })).rejects.toThrow('detached through this port');
    await expect(port.runBytes('xdg-open', [], { detached: true })).rejects.toThrow('detached through this port');
    expect(base.started).toEqual([]);
    expect(base.ran).toEqual([]);
  });
});

describe('detached spawn: the adapter', () => {
  function recorder() {
    const calls: { argv: readonly string[]; options: Parameters<DetachedSpawnCall>[1] }[] = [];
    let unrefs = 0;
    const call: DetachedSpawnCall = (argv, options) => {
      calls.push({ argv, options });
      return {
        pid: 9876,
        unref: () => {
          unrefs += 1;
        },
      };
    };
    return { calls, call, unrefs: () => unrefs };
  }
  const env = (_program: string, options?: SpawnOptions): Record<string, string> => ({
    BASE: '1',
    ...(options?.env as Record<string, string> | undefined),
  });

  test('its own process group (detached: true), every stream ignored, unreferenced, the env given', () => {
    const r = recorder();
    const handle = startDetached('xdg-open', [URL_WITH_QUERY], { detached: true, env: { DISPLAY: ':0' } }, env, r.call);
    expect(r.calls).toEqual([
      {
        argv: ['xdg-open', URL_WITH_QUERY],
        options: {
          env: { BASE: '1', DISPLAY: ':0' },
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
          detached: true,
        },
      },
    ]);
    expect(r.unrefs()).toBe(1);
    expect(handle.pid).toBe(9876);
  });

  test('a fenced cwd reaches the call', () => {
    const r = recorder();
    startDetached('open', [], { detached: true, cwd: '/w' as FencedPath }, env, r.call);
    expect(r.calls[0]?.options.cwd).toBe('/w');
  });

  test('the handle holds nothing: empty closed streams, no pipes, exited null at once, write and kill throw', async () => {
    const r = recorder();
    const handle = startDetached('xdg-open', [], { detached: true }, env, r.call);
    expect(await new Response(handle.stdout).text()).toBe('');
    expect(await new Response(handle.stderr).text()).toBe('');
    expect(handle.pipes).toEqual([]);
    handle.closePipes();
    expect(await handle.exited).toBeNull();
    expect(() => handle.write('x')).toThrow('no stdin');
    expect(() => handle.kill()).toThrow('not the daemon’s to signal');
  });

  test('the adapter refuses every combination again, with nothing started', () => {
    const pin = { install: () => () => undefined } as unknown as PinnedWorkingDirectory;
    const bad: readonly SpawnOptions[] = [
      { detached: true, extraPipes: 1 },
      { detached: true, stdin: 'x' },
      { detached: true, forFerret: 'f' as FerretId },
      { detached: true, timeout: 1 as SpawnOptions['timeout'] },
      { detached: true, signal: new AbortController().signal },
      { detached: true, cwd: pin },
      { detached: true, env: handleLike() },
    ];
    for (const options of bad) {
      const r = recorder();
      expect(() => startDetached('xdg-open', [], options, env, r.call)).toThrow('A detached child takes no');
      expect(r.calls).toEqual([]);
    }
  });

  test('bunSpawn run and runBytes refuse detached before anything starts', async () => {
    const port = bunSpawn({});
    await expect(port.run('definitely-not-run', [], { detached: true })).rejects.toThrow('never run');
    await expect(port.runBytes('definitely-not-run', [], { detached: true })).rejects.toThrow('never runBytes');
  });

  test('bunSpawn start with detached takes the detached path (a Vault handle refused, nothing started)', () => {
    const port = bunSpawn({});
    expect(() => port.start('definitely-not-run', [], { detached: true, env: handleLike() })).toThrow(
      'A detached child takes no',
    );
  });
});
