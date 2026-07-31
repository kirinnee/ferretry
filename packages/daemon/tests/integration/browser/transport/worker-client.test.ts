import { afterEach, describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import type { FrameClock } from '../../../../src/lib/index.ts';
import { BrowserWorkerClient, type WorkerClientOptions } from '../../../../src/adapters/browser/transport/index.ts';

const WORKER_ENTRY = join(import.meta.dir, 'fixtures', 'fake-worker.mjs');
const VIEWPORT = { width: 800, height: 600 } as const;

const started: BrowserWorkerClient[] = [];

async function connect(overrides: Partial<WorkerClientOptions> = {}): Promise<BrowserWorkerClient> {
  const client = await BrowserWorkerClient.connect({
    runtime: process.execPath,
    workerEntry: WORKER_ENTRY,
    endpoint: 'ready',
    readyTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    shutdownTimeoutMs: 500,
    frameIntervalMs: 0,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME, FY_SECRET: 'must-not-be-forwarded' },
    ...overrides,
  });
  started.push(client);
  return client;
}

const clientPid = (client: BrowserWorkerClient): number => client.pid;

/** Whether the process still exists; signal 0 only probes, it delivers nothing. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits briefly for a reaped child to leave the process table before judging it alive. */
async function settledDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await Bun.sleep(10);
  return !alive(pid);
}

/** Reads the params the worker actually received back out of the snapshot it reported. */
function reportedParams(url: string): unknown {
  return JSON.parse(new URL(url).searchParams.get('params') ?? 'null');
}

async function rejection(work: Promise<unknown>): Promise<{ code?: string; status?: number; message: string }> {
  try {
    await work;
    throw new Error('expected the call to fail');
  } catch (error) {
    const failure = error as { code?: string; status?: number; message: string };
    return { code: failure.code, status: failure.status, message: failure.message };
  }
}

afterEach(async () => {
  // Never leave a child behind: these are real processes.
  await Promise.all(started.splice(0).map(client => client.close().catch(() => undefined)));
});

describe('browser worker client — lifecycle', () => {
  it('should become ready despite junk and unknown records before the handshake', async () => {
    // Act
    const client = await connect();
    const snapshot = await client.location();

    // Assert
    should(snapshot.activePageId).equal('p1');
    should(snapshot.pages).have.length(1);
  });

  it('should fail the launch when the worker never becomes ready', async () => {
    // Act
    const failure = await rejection(connect({ endpoint: 'silent-launch', readyTimeoutMs: 150 }));

    // Assert
    should(failure.code).equal('launch_failed');
    should(failure.status).equal(503);
    should(failure.message).equal('browser worker did not become ready');
  });

  it('should fail the launch when the worker reports a fatal error', async () => {
    // Act
    const failure = await rejection(connect({ endpoint: 'fatal' }));

    // Assert
    should(failure.code).equal('launch_failed');
    should(failure.message).equal('browser worker failed: chromium is missing');
  });

  it('should fail the launch when the worker exits before the handshake', async () => {
    // Act
    const failure = await rejection(connect({ endpoint: 'exit-during-launch' }));

    // Assert
    should(failure.code).equal('launch_failed');
    should(failure.message).equal('browser worker exited during launch');
  });

  it('should fail the launch when the worker emits an oversized record', async () => {
    // Act
    const failure = await rejection(connect({ endpoint: 'overflow-during-launch', maxProtocolLineChars: 64 }));

    // Assert
    should(failure.code).equal('launch_failed');
    should(failure.message).equal('browser worker emitted an oversized protocol record');
  });

  it('should report an unexpected exit and fail everything still in flight', async () => {
    // Arrange
    const client = await connect();

    // Act
    const failure = await rejection(client.navigate('crashes'));

    // Assert: the fixture exits mid-request, so the pending call fails and the exit is observable.
    should(failure.code).be.oneOf(['upstream_failed', 'not_running']);
    should(await client.unexpectedExit).equal(3);

    // Act
    const afterExit = await rejection(client.location());

    // Assert
    should(afterExit.code).equal('not_running');
    should(afterExit.status).equal(409);
  });

  it('should close the worker and refuse later requests', async () => {
    // Arrange
    const client = await connect();

    // Act
    await client.close();
    await client.close();

    // Assert
    should((await rejection(client.location())).code).equal('not_running');
  });

  it('should escalate to SIGKILL for a worker that traps SIGTERM and ignores a closed stdin', async () => {
    // Arrange: the fixture traps SIGTERM and keeps a timer alive, like a worker closing Chrome.
    const client = await connect({ endpoint: 'stubborn-close', shutdownTimeoutMs: 150 });
    const pid = clientPid(client);

    // Act
    await client.close();

    // Assert: close() only reports success once the child is genuinely gone, not merely signalled.
    should(await settledDead(pid)).be.true();
  });

  it('should bound the whole shutdown by the shutdown timeout, not the request timeout', async () => {
    // Arrange: a worker that never answers 'close', with a request budget far larger than shutdown.
    const client = await connect({
      endpoint: 'stubborn-close',
      requestTimeoutMs: 30_000,
      shutdownTimeoutMs: 150,
    });
    const started = Bun.nanoseconds();

    // Act
    await client.close();

    // Assert: charging the request timeout first would hold up daemon shutdown for 30s per session.
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
    should(elapsedMs).be.below(3_000);
  });
});

describe('browser worker client — requests', () => {
  it('should carry every action method and its params to the worker', async () => {
    // Arrange
    const client = await connect();

    // Act
    const calls = [
      await client.navigate('https://example.test/next'),
      await client.click('#submit'),
      await client.type('#field', 'hello'),
      await client.back(),
      await client.forward(),
      await client.reload(),
      await client.newPage('https://example.test/tab'),
      await client.newPage(),
      await client.activatePage('p2'),
      await client.closePage('p3'),
      await client.resize(VIEWPORT),
    ];

    // Assert
    should(calls.map(call => call.title)).deepEqual([
      'navigate',
      'click',
      'type',
      'back',
      'forward',
      'reload',
      'newPage',
      'newPage',
      'activatePage',
      'closePage',
      'resize',
    ]);
    should(reportedParams(calls[0]?.url ?? '')).deepEqual({ url: 'https://example.test/next' });
    should(reportedParams(calls[2]?.url ?? '')).deepEqual({ selector: '#field', text: 'hello' });
    should(reportedParams(calls[7]?.url ?? '')).deepEqual({});
    should(reportedParams(calls[9]?.url ?? '')).deepEqual({ pageId: 'p3' });
    should(reportedParams(calls[10]?.url ?? '')).deepEqual({ width: 800, height: 600 });
    should(calls.every(call => call.actedPageId === 'p1')).be.true();
  });

  it('should return bounded read text and screenshot payloads with their snapshots', async () => {
    // Arrange
    const client = await connect();

    // Act
    const read = await client.read('#article');
    const readWithoutSelector = await client.read();
    const shot = await client.screenshot();

    // Assert
    should(read.text).equal('page text');
    should(reportedParams(read.url)).deepEqual({ selector: '#article' });
    should(reportedParams(readWithoutSelector.url)).deepEqual({});
    should(shot.screenshotBase64).equal('AAAA');
  });

  it('should grant the worker only the allowlisted environment, plus a forced loopback proxy bypass', async () => {
    // Arrange
    const client = await connect({
      environment: {
        PATH: process.env.PATH,
        HOME: '/home/example',
        LANG: 'en_US.UTF-8',
        FY_SECRET: 'must-not-be-forwarded',
        HTTP_PROXY: 'http://proxy.invalid:3128',
        NO_PROXY: 'nothing',
      },
    });

    // Act
    const granted = reportedParams((await client.navigate('environment')).url) as Record<string, string>;

    // Assert: nothing outside the allowlist reaches the browser, and loopback never goes via a proxy.
    should(granted['PATH']).equal('set');
    should(granted['HOME']).equal('/home/example');
    should(granted['LANG']).equal('en_US.UTF-8');
    should(granted).not.have.property('FY_SECRET');
    should(granted).not.have.property('HTTP_PROXY');
    should(granted['NO_PROXY']).equal('127.0.0.1,localhost,::1');
    should(granted['no_proxy']).equal('127.0.0.1,localhost,::1');
  });

  it('should dispatch human input to the worker', async () => {
    // Arrange
    const client = await connect();

    // Act
    await client.dispatchInput({ kind: 'insertText', text: 'typed' });

    // Assert: a dispatch that resolves is the whole contract; the worker echoes nothing back.
    should(await client.location()).have.property('activePageId', 'p1');
  });

  it('should surface a refused action as an upstream failure with a coarse message', async () => {
    // Arrange
    const client = await connect();

    // Act
    const failure = await rejection(client.click('refuses'));

    // Assert
    should(failure.code).equal('upstream_failed');
    should(failure.status).equal(502);
    should(failure.message).equal('browser action failed: click failed');
  });

  it('should refuse a snapshot the worker described incoherently', async () => {
    // Arrange
    const client = await connect();

    // Act
    const badSnapshot = await rejection(client.navigate('bad-snapshot'));
    const noActedPage = await rejection(client.navigate('no-acted-page'));
    const badLocation = await rejection((await connect({ endpoint: 'bad-location' })).location());

    // Assert
    should(badSnapshot.message).equal('browser worker returned an invalid active page');
    should(noActedPage.message).equal('browser worker returned no acted page');
    should(badLocation.code).equal('upstream_failed');
  });

  it('should time out a request the worker never answers', async () => {
    // Arrange
    const client = await connect({ requestTimeoutMs: 150 });

    // Act
    const failure = await rejection(client.navigate('never-replies'));

    // Assert
    should(failure.code).equal('upstream_failed');
    should(failure.status).equal(504);
    should(failure.message).equal('browser navigate timed out');
  });

  it('should stop a worker that violates the protocol after launch', async () => {
    // Arrange
    const client = await connect({ maxProtocolLineChars: 64 });

    // Act
    const failure = await rejection(client.navigate('overflows'));

    // Assert
    should(failure.message).equal('browser worker emitted an oversized protocol record');
    should(await client.unexpectedExit).equal(-1);
    should((await rejection(client.location())).code).equal('not_running');
  });
});

describe('browser worker client — screencast', () => {
  it('should publish attributable frames to every listener exactly once per frame', async () => {
    // Arrange
    const client = await connect();
    const first: BrowserScreencastFrame[] = [];
    const second: BrowserScreencastFrame[] = [];

    // Act
    await client.startScreencast(VIEWPORT, frame => void first.push(frame));
    // A second viewer joins an already-running screencast, so the worker is not asked twice.
    await client.startScreencast(VIEWPORT, frame => void second.push(frame));
    await client.navigate('emit-frames');

    // Assert: the identity-free frame the worker emitted never reaches a viewer.
    should(first.map(frame => frame.dataBase64)).deepEqual(['AAAA', 'BBBB']);
    should(second.map(frame => frame.dataBase64)).deepEqual(['AAAA', 'BBBB']);
  });

  it('should keep serving actions when a viewer callback throws', async () => {
    // Arrange
    const client = await connect();
    const seen: string[] = [];

    // Act
    await client.startScreencast(VIEWPORT, frame => {
      seen.push(frame.dataBase64);
      throw new Error('viewer exploded');
    });
    const snapshot = await client.navigate('emit-frames');

    // Assert
    should(seen).have.length(2);
    should(snapshot.activePageId).equal('p1');
  });

  it('should forget a listener when starting the screencast fails', async () => {
    // Arrange
    const client = await connect({ endpoint: 'no-screencast', requestTimeoutMs: 150 });

    // Act
    const failure = await rejection(client.startScreencast(VIEWPORT, () => undefined));

    // Assert
    should(failure.code).equal('upstream_failed');
    // The listener was forgotten, so a screencast that never started needs no stop request.
    await client.stopScreencast();
    should((await client.location()).activePageId).equal('p1');
  });

  it('should fail every viewer waiting on a start that never landed', async () => {
    // Arrange: B joins while A's request is still in flight.
    const client = await connect({ endpoint: 'no-screencast', requestTimeoutMs: 150 });
    const frames: BrowserScreencastFrame[] = [];

    // Act
    const first = rejection(client.startScreencast(VIEWPORT, () => undefined));
    const second = rejection(client.startScreencast(VIEWPORT, frame => void frames.push(frame)));

    // Assert: reporting success to B would hand it a permanently black viewport and no error.
    should((await first).code).equal('upstream_failed');
    should((await second).code).equal('upstream_failed');
    should(frames).be.empty();
  });

  it('should let a later viewer start a fresh screencast after an earlier attempt failed', async () => {
    // Arrange
    const client = await connect({ requestTimeoutMs: 150, endpoint: 'ready' });

    // Act: the first attempt is refused by the worker, the second is a genuine start.
    const refused = await rejection(client.startScreencast({ width: 0, height: 0 }, () => undefined));
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast(VIEWPORT, frame => void frames.push(frame));
    await client.navigate('emit-frames');

    // Assert
    should(refused.code).equal('upstream_failed');
    should(frames).have.length(2);
  });

  it('should pace frames through the governor, delivering only the newest within one interval', async () => {
    // Arrange: a controllable clock, so pacing is proved rather than timed.
    let now = 0;
    const timers: Array<{ at: number; run: () => void }> = [];
    const clock: FrameClock = {
      now: () => now,
      schedule: (callback, delayMs) => {
        const timer = { at: now + delayMs, run: callback };
        timers.push(timer);
        return {
          cancel: () => {
            const index = timers.indexOf(timer);
            if (index >= 0) timers.splice(index, 1);
          },
        };
      },
    };
    const client = await connect({ clock, frameIntervalMs: 1_000 });
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast(VIEWPORT, frame => void frames.push(frame));

    // Act: the worker emits two frames well inside one interval.
    await client.navigate('emit-frames');

    // Assert: the first is painted, the second is held as the newest rather than queued.
    should(frames.map(frame => frame.dataBase64)).deepEqual(['AAAA']);

    // Act: time reaches the next slot.
    now += 1_000;
    for (const timer of timers.splice(0).filter(timer => timer.at <= now)) timer.run();

    // Assert
    should(frames.map(frame => frame.dataBase64)).deepEqual(['AAAA', 'BBBB']);
  });

  it('should acknowledge each delivered frame so the browser may capture the next one', async () => {
    // Arrange
    const client = await connect();
    await client.startScreencast(VIEWPORT, () => undefined);

    // Act
    await client.navigate('emit-frames');
    const acks = reportedParams((await client.navigate('acknowledged')).url) as { acks: number[] };

    // Assert: only the frames that actually reached a viewer are acknowledged.
    should(acks.acks).have.length(2);
  });

  it('should rebind the capture window when the worker refuses an acknowledgement', async () => {
    // Arrange
    const client = await connect({ endpoint: 'refuses-acks' });
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast(VIEWPORT, frame => void frames.push(frame));

    // Act: a refused acknowledgement must not wedge the stream behind a dead window.
    await client.navigate('emit-frames');
    await client.navigate('emit-frames');

    // Assert
    should(frames.length).be.aboveOrEqual(2);
  });

  it('should stop the screencast once and ignore a redundant stop', async () => {
    // Arrange
    const client = await connect();
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast(VIEWPORT, frame => void frames.push(frame));
    await client.navigate('emit-frames');

    // Act
    await client.stopScreencast();
    await client.stopScreencast();

    // Assert
    should(frames).have.length(2);
    should((await client.location()).activePageId).equal('p1');
  });
});
