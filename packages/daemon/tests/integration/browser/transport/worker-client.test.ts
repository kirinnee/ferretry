import { afterEach, describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
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
    environment: { PATH: process.env.PATH, HOME: process.env.HOME, FY_SECRET: 'must-not-be-forwarded' },
    ...overrides,
  });
  started.push(client);
  return client;
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

  it('should terminate a worker that acknowledges close but never exits', async () => {
    // Arrange
    const client = await connect({ endpoint: 'stubborn-close', shutdownTimeoutMs: 100 });

    // Act
    await client.close();

    // Assert: the client falls back to a signal rather than waiting on the child forever.
    should(client).be.ok();
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
