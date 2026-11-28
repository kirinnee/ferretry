import { describe, expect, test } from 'bun:test';
import type { FencedPath } from '../../../contract/bound.ts';
import type { PinnedRoot, PinnedWorkingDirectory, SessionRootPinner } from '../../../contract/pinned.ts';
import type { SpawnOptions, SpawnPort } from '../../../contract/ports.ts';
import { PermissionError, restrictSpawn } from '../../../host/permissions.ts';
import { PinRegistry } from '../../../host/pins.ts';

const fakeRoot = (policyCwd: string | PinnedWorkingDirectory): PinnedRoot => ({
  rootReal: '/work/f1',
  policyCwd,
  open: async () => {
    throw new Error('not walked here');
  },
  probe: () => {
    throw new Error('not probed here');
  },
  close: async () => {},
});
const pinnerAnswering = (policyCwd: string | PinnedWorkingDirectory): SessionRootPinner => ({
  pin: async () => fakeRoot(policyCwd),
});

function recordingSpawn(): SpawnPort & { readonly cwds: unknown[] } {
  const cwds: unknown[] = [];
  const done = { exitCode: 0, signal: null, stdout: '', stderr: '' };
  return {
    cwds,
    run: async (_p, _a, options?: SpawnOptions) => (cwds.push(options?.cwd), done),
    runBytes: async (_p, _a, options) => (
      cwds.push(options?.cwd),
      {
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      }
    ),
    start: () => {
      throw new Error('not started here');
    },
  };
}

describe('kernel.spawn with a pinned cwd: only a pin this plugin’s roots minted', () => {
  test('a pin minted for the plugin is accepted and handed through as the held object', async () => {
    const held: PinnedWorkingDirectory = { describe: '/work/f1', install: () => () => {} };
    const pins = new PinRegistry(() => pinnerAnswering(held));
    const root = await pins.pin('ferrets', '/work/f1', undefined, 'write');
    const base = recordingSpawn();
    await restrictSpawn('ferrets', ['git'], base, undefined, pins).runBytes('git', ['status'], { cwd: root.policyCwd });
    expect(base.cwds).toEqual([held]);
  });

  test('a Linux pin is a path alias the plugin never holds: the child is given the alias', async () => {
    const pins = new PinRegistry(() => pinnerAnswering('/proc/1/fd/9'));
    const root = await pins.pin('ferrets', '/work/f1', undefined, 'write');
    expect(typeof root.policyCwd).toBe('object');
    const base = recordingSpawn();
    await restrictSpawn('ferrets', ['git'], base, undefined, pins).run('git', [], { cwd: root.policyCwd });
    expect(base.cwds).toEqual(['/proc/1/fd/9']);
  });

  test('a hand-made pin, or another plugin’s pin, is refused before anything starts', async () => {
    const pins = new PinRegistry(() => pinnerAnswering({ describe: '/work/f1', install: () => () => {} }));
    const theirs = await pins.pin('terminals', '/work/f1');
    const base = recordingSpawn();
    const port = restrictSpawn('ferrets', ['git'], base, undefined, pins);
    const forged: PinnedWorkingDirectory = { describe: '/', install: () => () => {} };
    await expect(port.run('git', [], { cwd: forged })).rejects.toThrow(PermissionError);
    await expect(port.run('git', [], { cwd: theirs.policyCwd })).rejects.toThrow(
      'ferrets may start a child only in a folder one of its own roots holds open.',
    );
    // a fenced string cwd is unchanged
    await port.run('git', [], { cwd: '/work/f1' as FencedPath });
    expect(base.cwds).toEqual(['/work/f1']);
  });

  test('the cwd forwarded is the same object whose write authority was checked', async () => {
    const writable: PinnedWorkingDirectory = { describe: '/write', install: () => () => {} };
    const readable: PinnedWorkingDirectory = { describe: '/read', install: () => () => {} };
    const pins = new PinRegistry(() => pinnerAnswering(writable));
    await pins.pin('ferrets', '/write', undefined, 'write');
    let reads = 0;
    const base = recordingSpawn();
    await restrictSpawn('ferrets', ['git'], base, undefined, pins).run('git', [], {
      get cwd() {
        return reads++ === 0 ? writable : readable;
      },
    });
    expect(base.cwds).toEqual([writable]);
    expect(reads).toBe(1);
  });

  test('a scoped write token keeps the held descriptor alive, then expires even if retained by the caller', async () => {
    let closed = 0;
    const backing = fakeRoot({ describe: '/work/f1', install: () => () => {} });
    const pins = new PinRegistry(() => ({
      pin: async () => ({
        ...backing,
        close: async () => {
          closed++;
        },
      }),
    }));
    const root = await pins.pin('ferrets', '/work/f1', undefined, 'read');
    const base = recordingSpawn();
    const spawn = restrictSpawn('ferrets', ['git'], base, undefined, pins);
    let retained = root.policyCwd;
    await pins.withWritePin(
      'ferrets',
      root.policyCwd,
      () => true,
      async cwd => {
        retained = cwd;
        await root.close();
        expect(closed).toBe(0);
        await spawn.run('git', [], { cwd });
      },
    );
    expect(closed).toBe(1);
    await expect(spawn.run('git', [], { cwd: retained })).rejects.toThrow(PermissionError);
    expect(base.cwds).toHaveLength(1);
  });
});
