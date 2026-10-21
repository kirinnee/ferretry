/**
 * A DAEMON THAT IS ALIVE MUST SAY SO, AND ONE THAT HAS STOPPED MUST NOT STAY.
 *
 * The defect: on a real Mac `fy daemon status` said "process exists but its API is unavailable" nearly
 * every time. The address was bound only after every boot step — twenty seconds of a closed port on a
 * large fleet — and once serving, a synchronous pass over huge transcripts held the event loop for
 * minutes at a time, during which nothing answered and nothing could restart it.
 *
 * These boot a REAL `fyd` in its own process whose usage-feed step is slow, hiccups or stalls, and play
 * the operator and the service manager against it. A child process because the watchdog ends a daemon
 * whose loop has stopped with SIGKILL, and a test runner it shared a process with would go with it.
 * Everything but that one step is the composition root's own: the real `start`, the real staged
 * surface, the real lag meter and the real watchdog thread.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import should from 'should';
import { buildWorld } from '../../../bin/fyd.ts';
import { freeLoopbackPort } from '../support/booted-daemon.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const modulePath = (relative: string): string => JSON.stringify(resolve(import.meta.dir, relative));

/**
 * The child's whole program. `slow` waits four seconds without blocking, as a boot over a large fleet
 * does; `hiccup` blocks the loop for 1.2 seconds after a moment and carries on; `stall` blocks it for a
 * minute, which the watchdog must end.
 */
const program = (mode: 'slow' | 'hiccup' | 'stall'): string => `
  import { buildWorld, start } from ${modulePath('../../../bin/fyd.ts')};
  import { NO_RELAY_DIRECTORY } from ${modulePath('../../../src/lib/relay/discovery.ts')};
  const mode = ${JSON.stringify(mode)};
  const block = milliseconds => { const until = Date.now() + milliseconds; while (Date.now() < until) {} };
  const world = buildWorld({}, { userHome: ${JSON.stringify(ABSENT_USER_HOME)} });
  process.exit(await start({
    ...world,
    relayDirectory: { read: async () => NO_RELAY_DIRECTORY },
    createUsageFeed: async config => {
      await Bun.sleep(mode === 'slow' ? 4_000 : 1_500);
      if (mode === 'hiccup') block(1_200);
      if (mode === 'stall') block(60_000);
      return await world.createUsageFeed(config);
    },
    untilShutdown: () => new Promise(() => undefined),
  }));
`;

interface Running {
  readonly child: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
  readonly base: string;
  /** Everything the daemon has written to its journal so far. */
  journal(): string;
  /** When the journal's `starting` line arrived, in this process's clock. */
  startedAtMs(): number | undefined;
}

const running: Running[] = [];

afterEach(async () => {
  for (const each of running.splice(0)) {
    each.child.kill('SIGKILL');
    await each.child.exited;
  }
  await cleanupTempDirectories();
});

async function seededHome(port: number): Promise<string> {
  const home = await tempDirectory('fyd-staged-boot-');
  const previous = process.env.FY_HOME;
  process.env.FY_HOME = home;
  const opened = await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open();
  await opened.storage.close();
  if (previous === undefined) delete process.env.FY_HOME;
  else process.env.FY_HOME = previous;
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(
    join(home, 'config', 'daemon.json'),
    JSON.stringify({ host: '127.0.0.1', port, relay: { url: 'ws://127.0.0.1:9', enabled: false } }),
    { mode: 0o600 },
  );
  return home;
}

async function boot(mode: 'slow' | 'hiccup' | 'stall', environment: Record<string, string> = {}): Promise<Running> {
  const port = await freeLoopbackPort();
  const home = await seededHome(port);
  const child = Bun.spawn({
    cmd: [process.execPath, '--eval', program(mode)],
    env: { ...process.env, FY_HOME: home, HOME: ABSENT_USER_HOME, ...environment },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let text = '';
  let startedAtMs: number | undefined;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      text += decoder.decode(chunk);
      if (startedAtMs === undefined && / starting — /u.test(text)) startedAtMs = Date.now();
    }
  })();
  const daemon: Running = {
    child,
    base: `http://127.0.0.1:${String(port)}`,
    journal: () => text,
    startedAtMs: () => startedAtMs,
  };
  running.push(daemon);
  return daemon;
}

interface Answer {
  readonly status: number;
  readonly body: { readonly status?: string; readonly boot?: { readonly step?: string; readonly phase?: string } };
  readonly atMs: number;
}

async function liveness(base: string): Promise<Answer | undefined> {
  const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
  if (response === undefined) return undefined;
  return { status: response.status, body: (await response.json()) as Answer['body'], atMs: Date.now() };
}

async function until<T>(read: () => Promise<T | undefined>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && done(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a daemon whose boot takes time', () => {
  it('should answer liveness within a second of starting, naming the step it is on', async () => {
    // Arrange
    const daemon = await boot('slow');

    // Act
    const first = await until(
      () => liveness(daemon.base),
      () => true,
      'the first liveness answer',
    );
    const onStep = await until(
      () => liveness(daemon.base),
      answer => answer.body.boot?.step === 'opening the usage feed',
      'the slow step to be reported',
    );
    const served = await until(
      () => liveness(daemon.base),
      answer => answer.status === 200,
      'the routes to mount',
    );
    const health = await fetch(`${daemon.base}/v1/health`);

    // Assert — the port used to stay closed for the whole boot.
    const startedAtMs = daemon.startedAtMs();
    should(startedAtMs).not.be.undefined();
    should(first.atMs - (startedAtMs ?? 0)).be.below(1_000);
    should(first.status).equal(503);
    should(first.body.status).equal('starting');
    should(onStep.status).equal(503);
    should(onStep.atMs - (startedAtMs ?? 0)).be.below(1_000);
    should(served.body.status).equal('ok');
    should(health.status).equal(200);
    should(daemon.journal()).match(/listening — http:\/\/127\.0\.0\.1:\d+ — answering \/healthz/u);
    should(daemon.journal()).match(/serving — every route is mounted/u);
  }, 30_000);

  it('should name a stall in its journal with the step that caused it', async () => {
    // Arrange
    const daemon = await boot('hiccup');

    // Act
    await until(
      () => liveness(daemon.base),
      answer => answer.status === 200,
      'the routes to mount',
    );

    // Assert
    should(daemon.journal()).match(/! event loop stalled for 1\.\d+s — during [^\n]*boot: opening the usage feed/u);
    const answer = await liveness(daemon.base);
    should(answer?.status).equal(200);
  }, 30_000);
});

describe('a daemon whose event loop has stopped', () => {
  it('should be ended by its watchdog so a service manager can start a fresh one', async () => {
    // Arrange — a one-second limit, so the case does not wait out the shipped five minutes.
    const daemon = await boot('stall', { FYD_WATCHDOG_SECONDS: '1' });
    await until(
      () => liveness(daemon.base),
      answer => answer.body.boot?.step === 'opening the usage feed',
      'the step that will stall',
    );

    // Act
    const exitedAtMs = await Promise.race([
      daemon.child.exited.then(() => Date.now()),
      Bun.sleep(15_000).then(() => undefined),
    ]);

    // Assert — the stall lasts a minute; the watchdog ended it in seconds, and said why first.
    should(exitedAtMs).not.be.undefined();
    should(daemon.child.signalCode).equal('SIGKILL');
    should(daemon.journal()).match(
      /! watchdog: the event loop has not run for \d+s \(during [^)]*boot: opening the usage feed[^)]*\) — ending this process/u,
    );
  }, 30_000);
});
