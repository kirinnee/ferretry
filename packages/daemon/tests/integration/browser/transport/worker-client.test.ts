import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { BrowserWorkerClient, type WorkerClientOptions } from '../../../../src/adapters/browser/transport/index.ts';
import type { FrameClock } from '../../../../src/lib/index.ts';
import { waitFor } from '../../support/wait-for.ts';

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

/** Waits for a reaped child to leave the process table, and says so only once it has. */
async function settledDead(pid: number): Promise<boolean> {
  await waitFor(() => !alive(pid), `process ${String(pid)} to leave the process table`);
  return true;
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
    const failure = await rejection(client.navigate('p1', 'crashes'));

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
});

describe('browser worker client — requests', () => {
  it('should carry every action method and its params to the worker', async () => {
    // Arrange
    const client = await connect();

    // Act
    const calls = [
      await client.navigate('p1', 'https://example.test/next'),
      await client.click('p1', { kind: 'selector', selector: '#submit' }),
      await client.type('p1', { kind: 'selector', selector: '#field' }, 'hello'),
      await client.back('p1'),
      await client.forward('p1'),
      await client.reload('p1'),
      await client.newPage({ url: 'https://example.test/tab', incognito: true }),
      await client.newPage({}),
      await client.closePage('p3'),
      await client.resize('p1', VIEWPORT),
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
      'closePage',
      'resize',
    ]);
    // Every page act names its page: there is no "active tab" for a request to fall back on.
    should(reportedParams(calls[0]?.url ?? '')).deepEqual({ pageId: 'p1', url: 'https://example.test/next' });
    should(reportedParams(calls[1]?.url ?? '')).deepEqual({
      pageId: 'p1',
      target: { kind: 'selector', selector: '#submit' },
    });
    should(reportedParams(calls[2]?.url ?? '')).deepEqual({
      pageId: 'p1',
      target: { kind: 'selector', selector: '#field' },
      text: 'hello',
    });
    should(reportedParams(calls[3]?.url ?? '')).deepEqual({ pageId: 'p1' });
    should(reportedParams(calls[6]?.url ?? '')).deepEqual({ url: 'https://example.test/tab', incognito: true });
    should(reportedParams(calls[7]?.url ?? '')).deepEqual({});
    should(reportedParams(calls[8]?.url ?? '')).deepEqual({ pageId: 'p3' });
    should(reportedParams(calls[9]?.url ?? '')).deepEqual({ pageId: 'p1', width: 800, height: 600 });
    should(calls.every(call => call.actedPageId === 'p1')).be.true();
  });

  it('should return bounded read text and screenshot payloads with their snapshots', async () => {
    // Arrange
    const client = await connect();

    // Act
    const read = await client.read('p1', { target: { kind: 'selector', selector: '#article' } });
    const readWithoutSelector = await client.read('p1');
    const tree = await client.read('p1', { target: { kind: 'selector', selector: 'main' }, mode: 'a11y' });
    const shot = await client.screenshot('p1');

    // Assert
    should(read.text).equal('page text');
    should(reportedParams(read.url)).deepEqual({ pageId: 'p1', target: { kind: 'selector', selector: '#article' } });
    should(reportedParams(readWithoutSelector.url)).deepEqual({ pageId: 'p1' });
    // The accessibility tree is asked for by mode, on the same request.
    should(reportedParams(tree.url)).deepEqual({
      pageId: 'p1',
      target: { kind: 'selector', selector: 'main' },
      mode: 'a11y',
    });
    should(shot.screenshotBase64).equal('AAAA');
    // A worker that names no format is an older one, whose screenshots were always PNG.
    should(shot.screenshotFormat).equal('png');
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
    const granted = reportedParams((await client.navigate('p1', 'environment')).url) as Record<string, string>;

    // Assert: nothing outside the allowlist reaches the browser, and loopback never goes via a proxy.
    should(granted.PATH).equal('set');
    should(granted.HOME).equal('/home/example');
    should(granted.LANG).equal('en_US.UTF-8');
    should(granted).not.have.property('FY_SECRET');
    should(granted).not.have.property('HTTP_PROXY');
    should(granted.NO_PROXY).equal('127.0.0.1,localhost,::1');
    should(granted['no_proxy']).equal('127.0.0.1,localhost,::1');
  });

  it('should dispatch human input to the worker', async () => {
    // Arrange
    const client = await connect();

    // Act
    await client.dispatchInput('p1', { kind: 'insertText', text: 'typed' });

    // Assert: a dispatch that resolves is the whole contract; the worker echoes nothing back.
    should(await client.location()).have.property('activePageId', 'p1');
  });

  it('should surface a refused action as an upstream failure with a coarse message', async () => {
    // Arrange
    const client = await connect();

    // Act
    const failure = await rejection(client.click('p1', { kind: 'selector', selector: 'refuses' }));

    // Assert
    should(failure.code).equal('upstream_failed');
    should(failure.status).equal(502);
    should(failure.message).equal('browser action failed: click failed');
  });

  it('should refuse a snapshot the worker described incoherently', async () => {
    // Arrange
    const client = await connect();

    // Act
    const badSnapshot = await rejection(client.navigate('p1', 'bad-snapshot'));
    const noActedPage = await rejection(client.navigate('p1', 'no-acted-page'));
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
    const failure = await rejection(client.navigate('p1', 'never-replies'));

    // Assert
    should(failure.code).equal('upstream_failed');
    should(failure.status).equal(504);
    should(failure.message).equal('browser navigate timed out');
  });

  it('should stop a worker that violates the protocol after launch', async () => {
    // Arrange
    const client = await connect({ maxProtocolLineChars: 64 });

    // Act
    const failure = await rejection(client.navigate('p1', 'overflows'));

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
    await client.startScreencast('p1', VIEWPORT, frame => void first.push(frame));
    // A second viewer joins an already-running screencast, so the worker is not asked twice.
    await client.startScreencast('p1', VIEWPORT, frame => void second.push(frame));
    await client.navigate('p1', 'emit-frames');

    // Assert: the identity-free frame the worker emitted never reaches a viewer.
    should(first.map(frame => frame.dataBase64)).deepEqual(['AAAA', 'BBBB']);
    should(second.map(frame => frame.dataBase64)).deepEqual(['AAAA', 'BBBB']);
  });

  it('should keep serving actions when a viewer callback throws', async () => {
    // Arrange
    const client = await connect();
    const seen: string[] = [];

    // Act
    await client.startScreencast('p1', VIEWPORT, frame => {
      seen.push(frame.dataBase64);
      throw new Error('viewer exploded');
    });
    const snapshot = await client.navigate('p1', 'emit-frames');

    // Assert
    should(seen).have.length(2);
    should(snapshot.activePageId).equal('p1');
  });

  it('should forget a listener when starting the screencast fails', async () => {
    // Arrange
    const client = await connect({ endpoint: 'no-screencast', requestTimeoutMs: 150 });

    // Act
    const listener = (): void => undefined;
    const failure = await rejection(client.startScreencast('p1', VIEWPORT, listener));

    // Assert
    should(failure.code).equal('upstream_failed');
    // The listener was forgotten, so a screencast that never started needs no stop request.
    await client.stopScreencast('p1', listener);
    should((await client.location()).activePageId).equal('p1');
  });

  it('should fail every viewer waiting on a start that never landed', async () => {
    // Arrange: B joins while A's request is still in flight.
    const client = await connect({ endpoint: 'no-screencast', requestTimeoutMs: 150 });
    const frames: BrowserScreencastFrame[] = [];

    // Act
    const first = rejection(client.startScreencast('p1', VIEWPORT, () => undefined));
    const second = rejection(client.startScreencast('p1', VIEWPORT, frame => void frames.push(frame)));

    // Assert: reporting success to B would hand it a permanently black viewport and no error.
    should((await first).code).equal('upstream_failed');
    should((await second).code).equal('upstream_failed');
    should(frames).be.empty();
  });

  it('should let a later viewer start a fresh screencast after an earlier attempt failed', async () => {
    // Arrange
    const client = await connect({ requestTimeoutMs: 150, endpoint: 'ready' });

    // Act: the first attempt is refused by the worker, the second is a genuine start.
    const refused = await rejection(client.startScreencast('p1', { width: 0, height: 0 }, () => undefined));
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast('p1', VIEWPORT, frame => void frames.push(frame));
    await client.navigate('p1', 'emit-frames');

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
    await client.startScreencast('p1', VIEWPORT, frame => void frames.push(frame));

    // Act: the worker emits two frames well inside one interval.
    await client.navigate('p1', 'emit-frames');

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
    await client.startScreencast('p1', VIEWPORT, () => undefined);

    // Act
    await client.navigate('p1', 'emit-frames');
    const acks = reportedParams((await client.navigate('p1', 'acknowledged')).url) as { acks: number[] };

    // Assert: only the frames that actually reached a viewer are acknowledged.
    should(acks.acks).have.length(2);
  });

  it('should rebind the capture window when the worker refuses an acknowledgement', async () => {
    // Arrange
    const client = await connect({ endpoint: 'refuses-acks' });
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast('p1', VIEWPORT, frame => void frames.push(frame));

    // Act: a refused acknowledgement must not wedge the stream behind a dead window.
    await client.navigate('p1', 'emit-frames');
    await client.navigate('p1', 'emit-frames');

    // Assert
    should(frames.length).be.aboveOrEqual(2);
  });

  it('should stop the screencast once and ignore a redundant stop', async () => {
    // Arrange
    const client = await connect();
    const frames: BrowserScreencastFrame[] = [];
    const listener = (frame: BrowserScreencastFrame): void => void frames.push(frame);
    await client.startScreencast('p1', VIEWPORT, listener);
    await client.navigate('p1', 'emit-frames');

    // Act
    await client.stopScreencast('p1', listener);
    await client.stopScreencast('p1', listener);
    await client.stopScreencast('p9', listener);

    // Assert
    should(frames).have.length(2);
    should((await client.location()).activePageId).equal('p1');
  });
});

describe('browser worker client — one stream per page', () => {
  it('should route each page’s frames to that page’s viewers only, and keep a page streaming until its last viewer leaves', async () => {
    // Arrange — the fake worker streams the page named by the emitting request.
    const client = await connect();
    const first: BrowserScreencastFrame[] = [];
    const second: BrowserScreencastFrame[] = [];
    const other: BrowserScreencastFrame[] = [];
    const onFirst = (frame: BrowserScreencastFrame): void => void first.push(frame);
    await client.startScreencast('p1', VIEWPORT, onFirst);
    await client.startScreencast('p1', VIEWPORT, frame => void second.push(frame));
    await client.startScreencast('p2', VIEWPORT, frame => void other.push(frame));

    // Act
    await client.navigate('p1', 'emit-frames');
    await client.stopScreencast('p1', onFirst);
    await client.navigate('p1', 'emit-frames');

    // Assert — p2's viewer saw none of p1's frames; p1 kept streaming for its remaining viewer.
    should(first.map(frame => frame.pageId)).deepEqual(['p1', 'p1']);
    should(second.length).be.above(first.length);
    should(other).deepEqual([]);
  });

  it('should drop a page’s stream when the page closes', async () => {
    const client = await connect();
    const frames: BrowserScreencastFrame[] = [];
    await client.startScreencast('p1', VIEWPORT, frame => void frames.push(frame));
    await client.closePage('p1');
    await client.navigate('p1', 'emit-frames');
    should(frames).deepEqual([]);
  });
});

describe('browser worker client — process handles', () => {
  const realSpawn = Bun.spawn;
  const directories: string[] = [];
  afterEach(async () => {
    Bun.spawn = realSpawn;
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  /** Makes every worker the client starts refuse to be signalled, the way a process in a bad state would. */
  function unsignallableWorkers(): void {
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const child = realSpawn(...args);
      return new Proxy(child, {
        get: (target, property) => {
          if (property === 'kill') {
            return () => {
              throw new Error('signal refused');
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof Bun.spawn;
  }

  it('should run a compiled worker executable directly, handing it the endpoint as its only argument', async () => {
    // Arrange: an executable standing in for the compiled worker, which takes no runtime in front of it.
    const directory = await mkdtemp(join(tmpdir(), 'ferretry-worker-executable-'));
    directories.push(directory);
    const executable = join(directory, 'worker');
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${WORKER_ENTRY}" "$@"\n`);
    await chmod(executable, 0o700);

    // Act
    const client = await connect({ workerExecutable: true, workerEntry: executable, runtime: '/must/not/be/run' });

    // Assert: it reached ready and answers a request, so the executable really was the worker.
    should(client.pid).be.above(0);
    should(await client.location('p1')).be.ok();
  });

  it('should report a worker that cannot be signalled as unterminated, rather than call it closed', async () => {
    // Arrange: no signal reaches the worker, so it never exits within the shutdown budget.
    unsignallableWorkers();
    const client = await connect({ endpoint: 'stubborn-close', shutdownTimeoutMs: 100 });
    const pid = clientPid(client);

    // Act
    const failure = await rejection(client.close());
    Bun.spawn = realSpawn;
    process.kill(pid, 'SIGKILL');

    // Assert
    should(failure.code).equal('upstream_failed');
    should(failure.status).equal(504);
    should(failure.message).equal('browser worker could not be terminated');
    should(await settledDead(pid)).be.true();
  });

  it('should still fail everything in flight when a worker that broke the protocol cannot be signalled', async () => {
    // Arrange
    unsignallableWorkers();
    const client = await connect({ maxProtocolLineChars: 64 });
    const pid = clientPid(client);

    // Act
    const failure = await rejection(client.navigate('p1', 'overflows'));
    Bun.spawn = realSpawn;
    process.kill(pid, 'SIGKILL');

    // Assert: the violation is what is reported; the failed signal is not.
    should(failure.message).equal('browser worker emitted an oversized protocol record');
    should(await client.unexpectedExit).equal(-1);
    should(await settledDead(pid)).be.true();
  });
});

describe('browser worker client — a secure copy', () => {
  it('should carry a copy read and believe only an answer in its shape, quoting none of a bad one', async () => {
    // Arrange
    const client = await connect();

    // Act
    const read = await client.copyRead('p1', { kind: 'ref', ref: 'e3' }, 'attribute', 'data-token');
    const text = await client.copyRead('p1', { kind: 'selector', selector: '#t' }, 'text');
    const missing = await client.copyRead('missing', { kind: 'ref', ref: 'e3' }, 'text');
    const garbled = await rejection(client.copyRead('garbled', { kind: 'ref', ref: 'e3' }, 'text'));
    const huge = await rejection(client.copyRead('huge', { kind: 'ref', ref: 'e3' }, 'text'));

    // Assert
    should(read).deepEqual({
      ok: true,
      value: 'fake-attribute-data-token-e3',
      origin: 'https://example.test',
      frameOrigin: 'https://frame.example',
      navigationId: 'loader-1',
    });
    should(text).match({ ok: true, value: 'fake-text--#t' });
    should(missing).deepEqual({ ok: false, reason: 'missing' });
    for (const failure of [garbled, huge]) {
      should(failure.code).equal('upstream_failed');
      should(failure.message).not.containEql('fake-');
      should(failure.message).not.containEql('xxxx');
    }
  });
});

describe('browser worker client — a push number', () => {
  it('should carry a push-number read and believe only an answer in its exact shape, quoting none of a bad one', async () => {
    // Arrange
    const client = await connect();

    // Act
    const read = await client.pushNumberRead('p1');
    const none = await client.pushNumberRead('none');
    // A number "from the element the ferret pointed at" is no source at all any more (secrev-1244 H1): refused.
    const failures = await Promise.all(
      ['both', 'long', 'extra', 'source', 'pointed', 'unread', 'garbled', 'reason'].map(
        async page => await rejection(client.pushNumberRead(page)),
      ),
    );

    // Assert
    should(read).deepEqual({
      origin: 'https://login.microsoftonline.com',
      navigationId: 'loader-1',
      provider: 'microsoft',
      number: { value: '42', from: 'microsoft', frameOrigin: 'https://login.microsoftonline.com' },
    });
    should(none).deepEqual({
      origin: 'https://login.microsoftonline.com',
      navigationId: 'loader-1',
      provider: 'microsoft',
      missing: 'none-found',
    });
    for (const failure of failures) {
      should(failure.code).equal('upstream_failed');
      should(failure.message).not.containEql('42');
      should(failure.message).not.containEql('fake-');
    }
  });
});

describe('browser worker client — the input bridge', () => {
  it('should carry the four input calls and believe only answers in the protocol’s shape', async () => {
    // Arrange
    const client = await connect();
    const pointer = [{ id: 'password', target: { kind: 'ref' as const, ref: 'e7' } }];

    // Act
    const seen = await client.inputObserve('p1', pointer);
    const missing = await client.inputObserve('missing', pointer);
    const document = await client.inputDocument('p1');
    const hostless = await client.inputDocument('hostless');
    const text = await client.inputText('p1');
    if (!seen.ok) throw new Error('the page should have been seen');
    const probed = await client.inputProbe('p1', seen.facts, ['password'], '~abcde');
    const echoes = await client.inputProbe('echoes', seen.facts, ['password'], '~abcde');
    const odd = await client.inputProbe('garbled', seen.facts, ['password'], '~abcde');
    const refused = await client.inputProbe('refuses', seen.facts, ['password'], '~abcde');
    if (!seen.ok) throw new Error('the page should have been seen');
    const shot = await client.inputShot('p1', seen.facts);
    const refound = await client.inputRefind('p1', seen.facts, pointer);
    const refoundMissing = await client.inputRefind('missing', seen.facts, pointer);
    const refoundAmbiguous = await client.inputRefind('ambiguous', seen.facts, pointer);
    const typed = await client.inputType('p1', seen.facts, [{ field: 'password', text: 'x' }], true);
    const changed = await client.inputType('p1', seen.facts, [{ field: 'password', text: 'x' }], false);

    // Assert
    should(seen.facts.fields[0]?.backendNodeId).equal(7);
    should(missing).deepEqual({ ok: false, missing: 'password' });
    should(document).deepEqual({ navigationId: 'loader-1', host: 'accounts.example.test' });
    should(hostless).deepEqual({ navigationId: 'loader-1' });
    should(text).equal('Welcome back');
    should(refound.ok && refound.facts.fields[0]?.backendNodeId).equal(9);
    should(refoundMissing).deepEqual({ ok: false, missing: 'password' });
    should(refoundAmbiguous).deepEqual({ ok: false, ambiguous: 'password' });
    should([probed, echoes, odd, refused]).deepEqual(['hidden', 'shown', 'aborted', 'aborted']);
    should(shot).deepEqual({ pngBase64: 'iVBORw0KGgo=', clip: { x: 0, y: 0, w: 10, h: 10 } });
    should(typed).equal('typed');
    should(changed).equal('target_changed');
  });

  it('should refuse a garbled look, picture or document, and call a garbled or failed write uncertain', async () => {
    // Arrange
    const client = await connect();
    const facts = {
      kind: 'browser' as const,
      pageId: 'p1',
      origin: 'https://example.test',
      secure: true,
      navigationId: 'loader-1',
      fields: [],
    } as never;

    // Act
    const observed = await rejection(client.inputObserve('garbled', []));
    const pictured = await rejection(client.inputShot('garbled', facts));
    const refound = await rejection(client.inputRefind('garbled', facts, []));
    const documented = await rejection(client.inputDocument('garbled'));
    const read = await rejection(client.inputText('garbled'));
    const garbled = await client.inputType('garbled', facts, [{ field: 'password', text: 'x' }], true);
    const refused = await client.inputType('refuses', facts, [{ field: 'password', text: 'x' }], true);

    // Assert
    for (const failure of [observed, pictured, documented, refound, read])
      should(failure.code).equal('upstream_failed');
    should(garbled).equal('uncertain');
    should(refused).equal('uncertain');
  });
});

describe('browser worker client — a grant fill’s clear (R3a-4)', () => {
  const facts = {
    kind: 'browser' as const,
    pageId: 'p1',
    origin: 'https://example.test',
    secure: true,
    navigationId: 'loader-1',
    fields: [],
  } as never;
  const job = {
    navigationId: 'loader-1',
    fields: [{ frameId: 'main', backendNodeId: 7, salt: 'a'.repeat(32), digest: 'b'.repeat(64) }],
  };

  it('should send the pagehide clear with the write only when asked', async () => {
    const client = await connect();
    const values = [{ field: 'password', text: 'x' }];
    should(await client.inputType('arms', facts, values, true, { armClear: true })).equal('typed');
    should(await client.inputType('arms', facts, values, true)).equal('target_changed');
  });

  it('should carry the clear job and believe only its three words, reading anything else as unknown', async () => {
    const client = await connect();
    should(await client.inputClear('p1', job)).equal('cleared');
    should(await client.inputClear('gone', job)).equal('moved');
    should(await client.inputClear('garbled', job)).equal('unknown');
    should(await client.inputClear('refuses', job)).equal('unknown');
  });
});
