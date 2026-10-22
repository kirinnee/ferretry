/**
 * A DAEMON THAT IS TOLD TO STOP, STOPS — with or without a phone on WebRTC.
 *
 * `fy daemon restart` and every update wait for the old process to exit, and a service manager that is
 * not answered waits out its stop timeout and then kills it. So the stop is held to a bound here, over a
 * real `fyd` in its own process: SIGTERM must end it, cleanly (exit code 0), inside
 * {@link SHUTDOWN_BOUND_MS} — once while nobody uses it, and once with a real libdatachannel peer
 * connected and its session channel open, the state a phone on WebRTC leaves a daemon in when it is
 * restarted for an update.
 *
 * It also holds the IDLE COST of the peer-to-peer engine to zero: a daemon nobody has offered to runs no
 * library thread at all (it used to run one per core, started by a boot-time self-test), and the first
 * offer is what starts them. Threads are read from `/proc`, so that half is Linux only.
 *
 * Loopback only: no relay, no ICE server, and the phone's peer binds 127.0.0.1.
 */
import { afterEach, describe, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import should from 'should';
import { buildWorld } from '../../../bin/fyd.ts';
import { freeLoopbackPort } from '../support/booted-daemon.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { dialWebRtc, type WebRtcPhone } from '../support/webrtc-phone.ts';

const FYD_ENTRY = resolve(import.meta.dir, '../../../bin/fyd.ts');
/** "Within a few seconds": the measured stop is tens of milliseconds, so this only catches a hang. */
const SHUTDOWN_BOUND_MS = 5_000;

const children: Bun.Subprocess[] = [];
const phones: WebRtcPhone[] = [];

afterEach(async () => {
  for (const phone of phones.splice(0)) phone.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  await cleanupTempDirectories();
});

/** The WebRTC library's threads in `pid`, by name, or `undefined` where there is no `/proc` to read. */
function libraryThreads(pid: number): number | undefined {
  const tasks = `/proc/${String(pid)}/task`;
  if (!existsSync(tasks)) return undefined;
  return readdirSync(tasks).filter(task => {
    const name = readFileSync(`${tasks}/${task}/comm`, 'utf8').trim();
    return name.startsWith('RTC') || name.startsWith('SCTP');
  }).length;
}

/** A real daemon in its own process and state home, serving on loopback with WebRTC switched on. */
async function bootServing(): Promise<{
  readonly child: Bun.Subprocess;
  readonly base: string;
  readonly home: string;
}> {
  const home = await tempDirectory('fyd-shutdown-');
  const port = await freeLoopbackPort();
  const previous = process.env.FY_HOME;
  process.env.FY_HOME = home;
  await (await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open()).storage.close();
  if (previous === undefined) delete process.env.FY_HOME;
  else process.env.FY_HOME = previous;
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(
    join(home, 'config', 'daemon.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port,
      relay: { url: 'ws://127.0.0.1:9', enabled: false },
      webrtc: { enabled: true, iceServers: [] },
    }),
    { mode: 0o600 },
  );
  const child = Bun.spawn({
    cmd: [process.execPath, FYD_ENTRY],
    env: { ...process.env, FY_HOME: home, HOME: ABSENT_USER_HOME },
    stdin: 'ignore',
    stdout: Bun.file(join(home, 'fyd.out')),
    stderr: Bun.file(join(home, 'fyd.err')),
  });
  children.push(child);
  const base = `http://127.0.0.1:${String(port)}`;
  // `ready`, not `/healthz`: the routes answer while the boot is still arming its loops, and the stop
  // this suite holds to a bound is the one a SERVING daemon makes.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const trail = await readFile(join(home, 'fyd.err'), 'utf8').catch(() => '');
    if (/ ready — serving /u.test(trail)) return { child, base, home };
    await Bun.sleep(50);
  }
  throw new Error(`the daemon never became ready: ${await readFile(join(home, 'fyd.err'), 'utf8')}`);
}

/** SIGTERM, and how long the process took to go, or `undefined` past the bound. */
async function stop(child: Bun.Subprocess): Promise<number | undefined> {
  const signalled = performance.now();
  child.kill('SIGTERM');
  const outcome = await Promise.race([child.exited.then(() => 'exited' as const), Bun.sleep(SHUTDOWN_BOUND_MS)]);
  return outcome === 'exited' ? performance.now() - signalled : undefined;
}

describe('a daemon told to stop', () => {
  it('should run no WebRTC thread while nobody has offered, and stop cleanly within the bound', async () => {
    // Arrange
    const { child, home } = await bootServing();
    const idleThreads = libraryThreads(child.pid);
    const trail = await readFile(join(home, 'fyd.err'), 'utf8');

    // Act
    const stoppedInMs = await stop(child);

    // Assert
    if (idleThreads !== undefined) should(idleThreads).equal(0);
    should(trail).match(/webrtc.*engine starts on the first peer-to-peer offer/u);
    should(stoppedInMs).be.a.Number().and.below(SHUTDOWN_BOUND_MS);
    should(child.exitCode).equal(0);
  });

  it('should start the engine for the first offer, and stop cleanly within the bound with the phone connected', async () => {
    // Arrange
    const { child, base, home } = await bootServing();
    const phone = await dialWebRtc(base, home);
    phones.push(phone);
    const connectedThreads = libraryThreads(child.pid);

    // Act
    const stoppedInMs = await stop(child);

    // Assert
    if (connectedThreads !== undefined) should(connectedThreads).be.above(2);
    should(phone.openMs).be.below(SHUTDOWN_BOUND_MS);
    should(stoppedInMs).be.a.Number().and.below(SHUTDOWN_BOUND_MS);
    should(child.exitCode).equal(0);
  });
});
