import { describe, expect, test } from 'bun:test';
import type { ChildHandle, SpawnOptions } from '@ferretry/kernel/contract';
import type { BrowserProfileLease, BrowserProfilePort } from '../../../daemon/worker/control/profile.ts';
import type { StartWorker } from '../../../daemon/worker/client.ts';
import {
  type LauncherPorts,
  NodeSessionBrowserLauncher,
  PIPE_TRANSPORT_REFUSAL,
  type SessionBrowserModeOptions,
} from '../../../daemon/worker/launcher.ts';
import { workerCommand } from '../../../daemon/worker/program.ts';
import { wallClock } from '../../support/wall-clock.ts';

/**
 * The launcher over fake kernel ports (lead decision, port-browsers r1): Chrome and the worker are each a `kernel.spawn`
 * child, the worker speaks today's protocol over its pipes, and the daemon — never the worker — reaps Chrome.
 */

const CHROME = '/fake/chrome';
const VIEWPORT = { width: 800, height: 600 } as const;

/** A child the test drives: what it was told, the signals it got, and an exit the test (or a signal) settles. */
interface FakeChild {
  readonly handle: ChildHandle;
  readonly signals: string[];
  readonly written: string[];
  say(line: string): void;
  exit(code: number | null): void;
}

function fakeChild(pid: number, onSignal: (signal: string, child: FakeChild) => void = () => undefined): FakeChild {
  let speak!: ReadableStreamDefaultController<Uint8Array>;
  let settle!: (code: number | null) => void;
  const stdout = new ReadableStream<Uint8Array>({
    start: controller => {
      speak = controller;
    },
  });
  const exited = new Promise<number | null>(resolve => {
    settle = resolve;
  });
  let done = false;
  const child: FakeChild = {
    signals: [],
    written: [],
    say: line => speak.enqueue(new TextEncoder().encode(`${line}\n`)),
    exit: code => {
      if (done) return;
      done = true;
      try {
        speak.close();
      } catch {
        // already closed
      }
      settle(code);
    },
    handle: {
      pid,
      pipes: [],
      closePipes: () => undefined,
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      write: chunk => void child.written.push(String(chunk)),
      kill: signal => {
        child.signals.push(signal ?? 'SIGTERM');
        onSignal(signal ?? 'SIGTERM', child);
      },
      exited,
    },
  };
  return child;
}

const lease = (released: string[]): BrowserProfileLease => ({
  profile: '/fake/profile',
  sessionId: 'agent-browser',
  daemonPid: 1,
  acquiredAt: '2026-11-07T00:00:00.000Z',
  recoveredDeadOwner: false,
  updateChromePid: async () => undefined,
  cleanupStaleChromeLocks: async () => [],
  markPrimed: async () => undefined,
  release: async () => {
    released.push('released');
    return true;
  },
});

function world(
  options: { readonly modes?: Partial<SessionBrowserModeOptions>; readonly chromeIgnoresTerm?: boolean } = {},
) {
  const acquired: string[] = [];
  const released: string[] = [];
  const spawned: { program: string; args: readonly string[]; options?: SpawnOptions }[] = [];
  const workerStarts: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  // Chrome exits on SIGTERM unless it ignores it (then only SIGKILL ends it).
  const chrome = fakeChild(4242, (signal, child) => {
    if (signal === 'SIGKILL' || options.chromeIgnoresTerm !== true) child.exit(null);
  });
  const workers: FakeChild[] = [];
  const profile: BrowserProfilePort = {
    acquire: async () => {
      acquired.push('acquired');
      return lease(released);
    },
    isPrimed: async () => true,
    assertChromeVersionCompatible: async () => undefined,
  };
  const ports: LauncherPorts = {
    clock: wallClock(),
    spawn: {
      run: async (program, args) => {
        spawned.push({ program, args });
        return { exitCode: 0, signal: null, stdout: 'Google Chrome 150.0\n', stderr: '' };
      },
      start: (program, args, spawnOptions) => {
        spawned.push({ program, args, ...(spawnOptions === undefined ? {} : { options: spawnOptions }) });
        return chrome.handle;
      },
    },
    fetch: { request: async () => new Response('{}') },
    host: { platform: 'linux', arch: 'x64', exists: path => path === CHROME, which: () => undefined },
  };
  const startWorker: StartWorker = (args, env) => {
    workerStarts.push({ args, env });
    // The worker exits on the close request or any signal, as today's does once it has closed its connection.
    const worker = fakeChild(5000 + workers.length, (_signal, child) => child.exit(0));
    workers.push(worker);
    queueMicrotask(() => worker.say('{"type":"ready"}'));
    return worker.handle;
  };
  const launcher = new NodeSessionBrowserLauncher(
    profile,
    startWorker,
    ports,
    { FY_CHROME_BIN: CHROME, PATH: '/usr/bin', HOME: '/home/example', FY_SECRET: 'must-not-be-forwarded' },
    undefined,
    {
      cdpPort: async () => 9333,
      listenerProver: { prove: async () => ({ kind: 'proven' }), holder: async () => undefined },
      shutdownTimeoutMs: 100,
      stageDirectory: '/fake/stage',
      ...options.modes,
    },
  );
  return { launcher, acquired, released, spawned, workerStarts, chrome, workers };
}

describe('the agent browser launcher, with the worker as a process of its own', () => {
  test('starts Chrome and the worker through kernel.spawn, handing the worker the port and only the allowlisted environment', async () => {
    // Arrange
    const w = world();

    // Act
    const browser = await w.launcher.launch(VIEWPORT);

    // Assert — Chrome's version run and Chrome itself are kernel.spawn children of the program the host found.
    expect(w.spawned.map(each => each.program)).toEqual([CHROME, CHROME]);
    expect(w.spawned[0]?.args).toEqual(['--version']);
    expect(w.spawned[1]?.args).toContain('--remote-debugging-port=9333');
    expect(w.spawned[1]?.args).not.toContain('--remote-debugging-pipe');
    // The worker gets the loopback endpoint and the stage directory as its arguments (today's argv).
    expect(w.workerStarts).toHaveLength(1);
    expect(w.workerStarts[0]?.args).toEqual(['http://127.0.0.1:9333', '/fake/stage']);
    expect(w.workerStarts[0]?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/example',
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    });
    await browser.close();
  });

  test('reaps Chrome ITSELF and frees the profile when the worker process dies, so no Chrome is orphaned', async () => {
    // Arrange
    const w = world();
    const browser = await w.launcher.launch(VIEWPORT);

    // Act — the worker dies without a word (a crash): nothing told Chrome to quit.
    w.workers[0]?.exit(137);
    const code = await browser.unexpectedExit;

    // Assert — the daemon signalled the Chrome it spawned, it is gone, and only then was the lease let go.
    expect(code).toBe(137);
    expect(w.chrome.signals).toEqual(['SIGTERM']);
    expect(w.released).toEqual(['released']);
  });

  test('escalates to SIGKILL on a Chrome that ignores SIGTERM after its worker died, and keeps no lease until it is gone', async () => {
    // Arrange
    const w = world({ chromeIgnoresTerm: true });
    const browser = await w.launcher.launch(VIEWPORT);

    // Act
    w.workers[0]?.exit(1);
    await browser.unexpectedExit;

    // Assert
    expect(w.chrome.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(w.released).toEqual(['released']);
  });

  test('closes the worker and reaps Chrome on an ordinary stop', async () => {
    // Arrange
    const w = world();
    const browser = await w.launcher.launch(VIEWPORT);

    // Act
    await browser.close();

    // Assert — the worker was asked to close over its stdin, and Chrome was reaped by the daemon.
    expect(w.workers[0]?.written.join('')).toContain('"method":"close"');
    expect(w.chrome.signals).toEqual(['SIGTERM']);
    expect(w.released).toEqual(['released']);
  });

  test('refuses a pipe launch with the sentence, before leasing the profile or starting anything (GAP: kernel spawn)', async () => {
    // Arrange
    const w = world({ modes: { transport: async () => 'pipe' } });

    // Act + Assert
    await expect(w.launcher.launch(VIEWPORT)).rejects.toThrow(PIPE_TRANSPORT_REFUSAL);
    expect(w.acquired).toEqual([]);
    expect(w.spawned).toEqual([]);
    expect(w.workerStarts).toEqual([]);
  });

  test('refuses before leasing when this host has no worker to start, naming the fix', async () => {
    // Arrange
    const refusal = workerCommand({ kind: 'missing', message: 'no worker beside the daemon' }, '/usr/bin/node');
    const w = world({ modes: { workerRefusal: () => ('refused' in refusal ? refusal.refused : undefined) } });

    // Act + Assert
    await expect(w.launcher.launch(VIEWPORT)).rejects.toThrow('no worker beside the daemon');
    expect(w.acquired).toEqual([]);
    expect(w.spawned).toEqual([]);
  });
});

describe('a stealth identity’s launch', () => {
  const DISPLAY = { display: async () => ':77', authority: () => '/fake/x11/cookie', close: async () => undefined };

  test('is a real window on the private display with the hygiene switches, the exit’s zone and language, and a worker told so — whatever Browser mode says', async () => {
    // Arrange — Browser mode is headless; the identity is stealth, with the zone and language its proxy exit gave.
    const w = world({
      modes: {
        mode: async () => 'headless',
        display: DISPLAY,
        stealth: async () => ({ timezone: 'Europe/Berlin', locale: 'de-DE' }),
      },
    });

    // Act
    const browser = await w.launcher.launch(VIEWPORT);

    // Assert
    const chrome = w.spawned[1];
    expect(chrome?.args).toContain('--disable-blink-features=AutomationControlled');
    expect(chrome?.args).toContain('--lang=de-DE');
    expect(chrome?.args.some(argument => argument.startsWith('--headless'))).toBe(false);
    expect(chrome?.args).toContain('--ozone-platform=x11');
    expect(chrome?.options?.env).toMatchObject({
      DISPLAY: ':77',
      XAUTHORITY: '/fake/x11/cookie',
      TZ: 'Europe/Berlin',
      LANGUAGE: 'de_DE',
    });
    expect(w.workerStarts[0]?.env).toMatchObject({ FY_BROWSER_WORKER_STEALTH: '1' });
    await browser.close();
  });

  const NOT_STEALTH: readonly [string, SessionBrowserModeOptions['stealth']][] = [
    ['no answer at all', undefined],
    ['an answer that cannot be read', async () => await Promise.reject(new Error('unreadable'))],
  ];
  test.each(NOT_STEALTH)(
    'leaves a launch that is not one byte for byte as it was (%s): no switch, no zone, headless, the stock worker',
    async (_name, stealth) => {
      // Arrange
      const w = world({
        modes: { mode: async () => 'headless', display: DISPLAY, ...(stealth === undefined ? {} : { stealth }) },
      });

      // Act
      const browser = await w.launcher.launch(VIEWPORT);

      // Assert
      const chrome = w.spawned[1];
      expect(chrome?.args).toContain('--headless=new');
      expect(chrome?.args.some(argument => /AutomationControlled|^--lang=|^--accept-lang=/u.test(argument))).toBe(
        false,
      );
      expect(chrome?.options?.env).not.toHaveProperty('TZ');
      expect(chrome?.options?.env).not.toHaveProperty('LANGUAGE');
      expect(w.workerStarts[0]?.env).not.toHaveProperty('FY_BROWSER_WORKER_STEALTH');
      await browser.close();
    },
  );

  test('keeps the machine’s own zone and language when its proxy gave no exit to match', async () => {
    const w = world({ modes: { display: DISPLAY, stealth: async () => ({}) } });

    const browser = await w.launcher.launch(VIEWPORT);

    expect(w.spawned[1]?.args).toContain('--disable-blink-features=AutomationControlled');
    expect(w.spawned[1]?.options?.env).not.toHaveProperty('TZ');
    expect(w.spawned[1]?.args.some(argument => argument.startsWith('--lang='))).toBe(false);
    await browser.close();
  });
});

describe('the worker program', () => {
  test('runs the compiled worker directly, and the source entry under Node with the type-transform flags', () => {
    expect(workerCommand({ kind: 'executable', path: '/opt/fy/fyd-browser-worker' }, '/usr/bin/node')).toEqual({
      program: '/opt/fy/fyd-browser-worker',
      args: [],
    });
    expect(workerCommand({ kind: 'source', entry: '/src/main.ts' }, '/usr/bin/node')).toEqual({
      program: '/usr/bin/node',
      args: ['--experimental-transform-types', '--no-warnings', '/src/main.ts'],
    });
    expect(workerCommand({ kind: 'source', entry: '/src/main.ts' }, undefined)).toHaveProperty('refused');
  });
});

describe('the agent browser’s clipboard, by where its window is drawn', () => {
  test('answers shared, asking the worker nothing, for a real window on a desktop (the computer’s own clipboard)', async () => {
    const w = world({ modes: { mode: async () => 'window', platform: 'darwin' } });
    const browser = await w.launcher.launch(VIEWPORT);

    const read = await browser.copyClipboard('pg-1');

    expect(read).toEqual({ ok: false, reason: 'shared' });
    // Not one request about the clipboard reached the worker.
    expect(w.workers[0]?.written.join('')).not.toContain('clipboardRead');
    await browser.close();
  });
});
