/**
 * Parity rows J-0014, J-0059, J-0063, J-0064, J-0105, J-0130, J-0152, J-0155, J-0162, J-0164, J-0166, J-0180, J-0189,
 * J-0192, J-0196, J-0199, J-0200, J-0208, J-0209, J-0271 (docs/design/rebuild-parity.tsv): today's browser timers and
 * watchers. A daemon-side wait runs on the kernel clock; a wait inside the browser worker runs in the worker's own
 * process (the `daemon/worker/adapters/` exemption), or on the wait its caller hands in.
 *
 * Not here, and why:
 * - J-0170 (the proxy probe's deadline) needs a real socket, which the unit tier refuses;
 *   `tests/integration/proxy/probe.test.ts` names and runs it.
 * - J-0151 (`dial`'s connect deadline, now the socket's own inactivity timeout) fires only on a connect that never
 *   completes, which no loopback peer can stage; it stays unchecked.
 * - J-0079 (`tunnel.start`) is the daemon's Cloudflare tunnel carrier — Connections', not a browser timer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ChildHandle, Clock, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, fixedClock, type TestHost, testHost } from '@ferretry/kernel/testing';
import { instantFromEpochMs } from '@ferretry/std';
import daemon, { buildBrowsers } from '../../../daemon/index.ts';
import { LoopbackFirewallWatch, readLoopbackFirewall } from '../../../daemon/proxy/firewall/state.ts';
import { KernelFrameClock } from '../../../daemon/stream/frame-clock.ts';
import {
  armInputFields,
  observeInputFields,
  probeInputFields,
  readInputText,
} from '../../../daemon/target/lib/fields.ts';
import { BrowserWorkerClient } from '../../../daemon/worker/client.ts';
import { type DialogTimers, type HeldDialogPort, PageDialogs } from '../../../daemon/worker/adapters/page-lifecycle.ts';
import { FakeWorld } from '../../support/page-world.ts';
import { Tabs } from '../../support/tabs.ts';

const DAEMON = new URL('../../../daemon/', import.meta.url);

/** A login page: a user box and a password box, as the input-field tests use. */
function loginWorld(): FakeWorld {
  const world = new FakeWorld();
  world.element('#user', 11, ['type', 'text', 'name', 'username', 'id', 'user', 'autocomplete', 'username']);
  world.element('#pw', 12, ['type', 'password', 'name', 'pw', 'autocomplete', 'current-password']);
  return world;
}

describe('where the browser’s waits run', () => {
  test('J-0063 J-0064 J-0152 J-0162 J-0164 J-0196 J-0199 J-0271 a global timer is armed only inside the worker process, never by the daemon', async () => {
    // Arrange — every daemon-side source file of Browsers.
    const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: DAEMON.pathname })];

    // Act — the files that arm a global timer (a socket's own inactivity timeout is not one).
    const arming: string[] = [];
    for (const file of files) {
      const text = await Bun.file(new URL(file, DAEMON)).text();
      if (/(?<![.\w])set(?:Timeout|Interval)\(/u.test(text)) arming.push(file);
    }

    // Assert — the screencast start, page open, title wait, socket watch, script deadline and lifecycle pauses all
    // run in the worker's own process; the download stage and the input fields wait on what their caller hands in.
    expect(arming.length).toBeGreaterThan(0);
    for (const file of arming) expect(file.startsWith('worker/adapters/')).toBe(true);
  });

  test('J-0059 importing the worker entry starts nothing; only running it as its own process does', async () => {
    const entry = await import('../../../daemon/worker/adapters/main.ts');
    expect(typeof entry.startBrowserWorker).toBe('function');
  });
});

describe('the waits the input fields are handed', () => {
  test('J-0192 a page that never says its title is read with an empty title once the handed-in wait runs out', async () => {
    // Arrange
    const world = loginWorld();
    const waited: number[] = [];
    const subject = {
      ...world.subject,
      page: { ...world.subject.page, title: () => new Promise<string>(() => undefined) },
      wait: async (ms: number) => void waited.push(ms),
    };

    // Act
    const text = await readInputText(subject);

    // Assert
    expect(waited).toEqual([750]);
    expect(text.split('\n').at(-2)).toBe('');
  });

  test('J-0166 the probe’s second look waits on the wait it is handed, never a timer of its own', async () => {
    // Arrange
    const world = loginWorld();
    const observed = await observeInputFields(world.subject, [
      { id: '#pw', target: { kind: 'selector', selector: '#pw' } },
    ]);
    if (!observed.ok) throw new Error('not observed');
    const waited: number[] = [];

    // Act
    const outcome = await probeInputFields(world.subject, observed.facts, ['#pw'], '~a1', async ms => {
      waited.push(ms);
    });

    // Assert
    expect(outcome).toBe('hidden');
    expect(waited).toHaveLength(1);
  });

  test('J-0014 arming a grant fill on a closed page, or on no field, arms nothing', async () => {
    const world = loginWorld();
    const observed = await observeInputFields(world.subject, [
      { id: '#pw', target: { kind: 'selector', selector: '#pw' } },
    ]);
    if (!observed.ok) throw new Error('not observed');
    expect(await armInputFields(world.subject, observed.facts, [])).toBe('refused');
    world.closed = true;
    expect(await armInputFields(world.subject, observed.facts, ['#pw'])).toBe('refused');
  });
});

describe('the worker’s dialog hold', () => {
  test('J-0189 a dialog nobody answers is dismissed when the hold timer it was handed fires', () => {
    // Arrange
    const armed: { callback: () => void; ms: number }[] = [];
    const timers: DialogTimers = {
      set: (callback, ms) => armed.push({ callback, ms }),
      clear: () => undefined,
    };
    const answers: string[] = [];
    const dialog: HeldDialogPort = {
      type: () => 'confirm',
      message: () => 'Delete everything?',
      accept: async () => void answers.push('accept'),
      dismiss: async () => void answers.push('dismiss'),
    };
    const dialogs = new PageDialogs(timers, 30_000);
    dialogs.hold('p1', dialog);

    // Act
    for (const timer of armed) timer.callback();

    // Assert
    expect(armed.map(timer => timer.ms)).toEqual([30_000]);
    expect(answers).toEqual(['dismiss']);
  });
});

describe('the daemon’s waits on the kernel clock', () => {
  test('J-0180 J-0208 J-0209 the frame pacing and the viewer stream’s recovery poll are kernel-clock timers', async () => {
    // Arrange
    const clock = fixedClock();
    const frames = new KernelFrameClock(clock);
    const fired: string[] = [];

    // Act
    frames.schedule(() => fired.push('flush'), 40);
    const cancelled = frames.schedule(() => fired.push('recovery'), 40);
    cancelled.cancel();
    await clock.advance(39);
    const early = [...fired];
    await clock.advance(1);

    // Assert
    expect(early).toEqual([]);
    expect(fired).toEqual(['flush']);
    expect(frames.now()).toBe(clock.nowMs());
  });

  test('J-0200 J-0155 the worker’s ready deadline and every exit wait run on the kernel clock, escalating to SIGKILL', async () => {
    // Arrange — a clock that jumps to each deadline at once, and a worker that never says ready and ignores SIGTERM.
    const delays: number[] = [];
    const clock: Clock = {
      now: () => instantFromEpochMs(0),
      nowMs: () => 0,
      after: (delay, fn) => {
        delays.push(Number(delay));
        const timer = setTimeout(fn, 0);
        return () => clearTimeout(timer);
      },
      every: () => () => undefined,
      sleep: async () => undefined,
    };
    const signals: string[] = [];
    let exit!: (code: number | null) => void;
    const child: ChildHandle = {
      pid: 5000,
      pipes: [],
      closePipes: () => undefined,
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      write: () => undefined,
      kill: signal => {
        signals.push(signal ?? 'SIGTERM');
        if (signal === 'SIGKILL') exit(null);
      },
      exited: new Promise(resolve => {
        exit = resolve;
      }),
    };

    // Act
    const failure = await BrowserWorkerClient.connect({
      start: () => child,
      endpoint: 'http://127.0.0.1:9333',
      clock,
      readyTimeoutMs: 1_234,
      shutdownTimeoutMs: 77,
    }).then(
      () => new Error('connected'),
      (error: unknown) => error as Error,
    );

    // Assert
    expect(failure.message).toBe('browser worker did not become ready');
    expect(delays[0]).toBe(1_234);
    expect(delays.slice(1).every(delay => delay === 77)).toBe(true);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  describe('the browser’s idle stop', () => {
    let host: TestHost | undefined;
    afterEach(async () => {
      await host?.stop();
      host = undefined;
    });

    test('J-0130 the browser stops itself on the kernel clock fifteen minutes after its last use with nobody watching', async () => {
      // Arrange
      const tabs = new Tabs();
      const clock = fixedClock();
      const half = implementDaemon(daemon.manifest, {
        build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } }),
      });
      const gate = new StandInAdmission(request =>
        request.arrival.kind === 'local' && request.arrival.privileged
          ? ferretStanding('f1' as FerretId)
          : ownerStanding(),
      );
      host = await testHost({
        plugins: [half],
        uses: {
          ferrets: { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) },
          agentControl: { allows: async () => true },
        },
        fakes: { vault: new FakeVault(), gate: new FakeGate() },
        gate,
        clock,
      });
      await host.tool('browser_open', { name: 'app', url: 'https://example.test/' }, { as: ferret('f1') });
      const running = (await host.request('GET', '/v1/browser/state')).json() as { state: string };

      // Act
      await clock.advance(15 * 60_000 - 1);
      const before = (await host.request('GET', '/v1/browser/state')).json() as { state: string };
      await clock.advance(1);
      const after = (await host.request('GET', '/v1/browser/state')).json() as { state: string };

      // Assert
      expect(running.state).toBe('running');
      expect(before.state).toBe('running');
      expect(after.state).toBe('stopped');
    });
  });
});

describe('the periodic loopback firewall check', () => {
  test('J-0105 GAP: not armed — with no browserPorts reading the host gets random ports, and a reading of random reads no marker and says nothing', async () => {
    // GAP (card F1931): today re-reads the marker every five minutes (`setInterval(checkLoopbackFirewall, …)`), and
    // reads nothing while `browserPorts` is random. 5.0 gives Browsers no read of the machine's `browserPorts`
    // (Runtimes keeps it, and no contract serves it), so every launch takes random ports and there is nothing to
    // fence; the tick is armed when that fact is served (finding 10).
    let markerReads = 0;
    const said: string[] = [];
    const watch = new LoopbackFirewallWatch(
      async () =>
        await readLoopbackFirewall(
          async () => 'random',
          1000,
          {
            read: async () => {
              markerReads += 1;
              return undefined;
            },
          },
          () => 0,
        ),
      message => said.push(message),
    );

    expect(await watch.check(true)).toBeUndefined();
    expect(markerReads).toBe(0);
    expect(said).toEqual([]);
  });
});
