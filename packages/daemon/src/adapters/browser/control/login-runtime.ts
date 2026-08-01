import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { hostname as osHostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { BROWSER_MAX_HEIGHT, BROWSER_MAX_WIDTH, type BrowserViewport } from '@ferretry/protocol';
import { BrowserControlError, selectChromeExecutable } from '../../../lib/browser/control/index.ts';
import type { BrowserLoginChild, BrowserLoginRuntime } from './login-window.ts';

/**
 * The host effects `BrowserLoginWindowService` was written against, and the X display it renders on.
 *
 * WHY THIS FILE IS THE WHOLE BLOCKER. `BrowserLoginWindowService` has been built, tested and
 * unreachable since PR #15, and the reachability allowlist recorded the reason precisely: the service
 * is a pure coordinator over `BrowserLoginRuntime`, and nothing in this repository implemented that
 * port. Every effect the window needs is named by the interface — a display, three executables, a
 * spawn, a free port, a 0600 secret file, two readiness waits and two terminations — so this is a
 * PORT of the one missing adapter rather than a design.
 *
 * TWO CLASSES, ONE FILE, because the display is not a collaborator the runtime merely calls: the
 * `BrowserLoginRuntime` contract has a `display()` and NO release, so whoever answers it owns that X
 * server's whole lifetime. Splitting them would hide that ownership behind an import.
 *
 * THE DISPLAY IS OWNED, NEVER INHERITED, and that is the security decision in this file. `$DISPLAY`
 * on the host is the operator's own desktop, and this window's entire purpose is to serve a display
 * over VNC to whoever holds the password. Attaching x11vnc to an ambient display would publish the
 * operator's real session; attaching it to an Xvfb this daemon started publishes a virtual screen
 * with nothing on it but the Chrome the window launched.
 *
 * NO TIMERS. Every wait here is `sleep` + `now` against a deadline rather than a `setTimeout` race,
 * so a test drives readiness, expiry and termination by advancing an injected clock instead of
 * waiting for wall-clock milliseconds — and a resolved wait leaves no armed timer behind to keep a
 * shutting-down daemon's event loop alive.
 */

/** A spawned program the runtime only starts, watches and signals. */
export type BrowserLoginSpawner = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) => BrowserLoginChild;

/** A spawned program the runtime runs to completion for its output — `chrome --version`, and nothing
 *  else. Separate from the spawner because the two differ in what they do with stdio, and a window
 *  that captured its Chrome's output would hold a pipe nobody drains for the life of the window. */
export type BrowserLoginProgramReader = (argv: readonly string[]) => Promise<{
  readonly code: number;
  readonly stdout: string;
}>;

/** An Xvfb child, which unlike every other child is read from: `-displayfd` is how it reports both
 *  the display it took and the fact that it is ready to serve it. */
export interface XvfbChild extends BrowserLoginChild {
  readonly stdout: ReadableStream<Uint8Array>;
}

/** The X display the login window renders on, and the release the runtime performs at shutdown. */
export interface BrowserDisplayPort {
  /** The `:N` an X client connects to. Idempotent: the same display for every caller. */
  display(): Promise<string>;
  /** Releases the display. Safe to call when none was ever taken. */
  close(): Promise<void>;
}

/** How long a readiness wait may take, and how often it looks. Both are injected so a test can drive
 *  the deadline with a fake clock rather than sleeping through it. */
export interface BrowserLoginTiming {
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** How long a terminated child is given to exit on SIGTERM before it is killed. */
  readonly terminateGraceMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_TIMING = {
  readinessTimeoutMs: 20_000,
  pollIntervalMs: 100,
  terminateGraceMs: 3_000,
} as const;

/** Chrome's only startup signal when it is launched without a debugging port. */
const chromeStartupMarker = 'SingletonLock';

/** The file x11vnc reads its password out of and then deletes (`-passwdfile rm:`). */
const vncPasswordName = 'vnc-password';

/**
 * A wait that is resolved by a predicate, cancelled by the child dying, and bounded by a deadline.
 *
 * Shared by both classes below because all four waits in this file are the same shape, and the child
 * check is the part that must not be forgotten: without it, a Chrome that failed to start is
 * indistinguishable from a Chrome that is merely slow, and the window reports a timeout twenty
 * seconds later instead of the launch failure it already had.
 */
async function awaitReady(options: {
  readonly what: string;
  readonly child: BrowserLoginChild;
  readonly ready: () => boolean | Promise<boolean>;
  readonly timing: Required<Pick<BrowserLoginTiming, 'readinessTimeoutMs' | 'pollIntervalMs' | 'now' | 'sleep'>>;
  /** A better sentence than "not ready in time", when the caller learned WHY while waiting. A child
   *  that answered unusably is still alive, so the deadline is the only thing that ends its wait — and
   *  reporting the elapsed milliseconds would hide the answer that was already in hand. */
  readonly stalled?: () => string | undefined;
}): Promise<void> {
  const { what, child, ready, timing } = options;
  let exitCode: number | undefined;
  // Observed rather than awaited: the loop must be able to see a dead child without blocking on one
  // that is alive. The rejection handler is deliberately present — a child whose `exited` rejects is
  // still a child that is not running, and an unhandled rejection would take the daemon down.
  void child.exited.then(
    code => {
      exitCode = code;
    },
    () => {
      exitCode = -1;
    },
  );
  const deadline = timing.now() + timing.readinessTimeoutMs;
  for (;;) {
    if (await ready()) return;
    if (exitCode !== undefined) {
      throw new BrowserControlError('launch_failed', `${what} exited with status ${exitCode} before it was ready`);
    }
    if (timing.now() >= deadline) {
      throw new BrowserControlError(
        'launch_failed',
        options.stalled?.() ?? `${what} was not ready within ${timing.readinessTimeoutMs}ms`,
      );
    }
    await timing.sleep(timing.pollIntervalMs);
  }
}

/** Drops the keys Bun refuses so an absent optional variable is absent rather than the string
 *  `"undefined"` — `browserEnvironment` deliberately produces a sparse record. */
function definedEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) result[key] = value;
  return result;
}

/** The timing block with every field resolved, so no wait has to defend against a missing default. */
function resolveTiming(
  timing: BrowserLoginTiming,
): Required<Pick<BrowserLoginTiming, 'readinessTimeoutMs' | 'pollIntervalMs' | 'now' | 'sleep'>> {
  return {
    readinessTimeoutMs: timing.readinessTimeoutMs ?? DEFAULT_TIMING.readinessTimeoutMs,
    pollIntervalMs: timing.pollIntervalMs ?? DEFAULT_TIMING.pollIntervalMs,
    now: timing.now ?? (() => Date.now()),
    sleep: timing.sleep ?? (async milliseconds => await Bun.sleep(milliseconds)),
  };
}

export interface XvfbDisplayOptions extends BrowserLoginTiming {
  /**
   * Absolute path to Xvfb, or `undefined` on a host without one — in which case the first `start`
   * refuses with a sentence naming what to install.
   *
   * A LOOKUP rather than a value, resolved at the moment the display is taken. `PATH` is read at the
   * point of use everywhere else in this composition root for the same reason: a daemon whose
   * environment gains a package directory after it booted must find what the operator installed, not
   * what its startup environment happened to hold.
   */
  readonly executable: () => string | undefined;
  readonly screen?: BrowserViewport;
  readonly spawn?: (argv: readonly string[]) => XvfbChild;
}

/**
 * A private X display, from an Xvfb this daemon started and closes.
 *
 * `-displayfd` rather than a display number this adapter picks. Xvfb takes a free display itself and
 * writes the number it took to that descriptor once it is ACCEPTING CONNECTIONS, so one mechanism
 * answers both questions the caller has — which display, and is it up — and there is no window in
 * which two daemons on one host can choose the same number.
 *
 * `-nolisten tcp` because nothing off this machine may reach the screen. The VNC server is the only
 * published door, and it binds loopback under a one-shot password.
 *
 * The display is created ONCE and lives until the daemon stops, not until the window closes. The
 * runtime contract has no release hook, so a display torn down per window would either leak on every
 * failed open — `display()` succeeds before the spawns that can throw — or need a refcount nothing
 * in the contract can express. One long-lived virtual screen with nothing on it is the cheaper and
 * more honest of the two, and the composition root registers `close` beside every other acquisition.
 */
export class XvfbDisplay implements BrowserDisplayPort {
  private readonly timing: ReturnType<typeof resolveTiming>;
  private readonly spawn: (argv: readonly string[]) => XvfbChild;
  private taken: Promise<string> | undefined;
  private child: XvfbChild | undefined;

  constructor(private readonly options: XvfbDisplayOptions) {
    this.timing = resolveTiming(options);
    this.spawn =
      options.spawn ??
      (argv => {
        const child = Bun.spawn({ cmd: [...argv], stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
        return {
          pid: child.pid,
          exited: child.exited,
          stdout: child.stdout,
          kill: signal => child.kill(signal),
        };
      });
  }

  async display(): Promise<string> {
    // Memoized on the PROMISE, so two concurrent opens share one X server rather than racing two.
    // A failure clears the memo: the next `start` should try again, not replay the old error.
    this.taken ??= this.take();
    try {
      return await this.taken;
    } catch (error) {
      this.taken = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.taken = undefined;
    if (child === undefined) return;
    child.kill('SIGTERM');
  }

  private async take(): Promise<string> {
    const executable = this.options.executable();
    if (executable === undefined) {
      throw new BrowserControlError(
        'launch_failed',
        'Xvfb was not found on this host; the login window renders on a private X display rather than the operator’s own',
      );
    }
    const screen = this.options.screen ?? { width: BROWSER_MAX_WIDTH, height: BROWSER_MAX_HEIGHT };
    const child = this.spawn([
      executable,
      '-displayfd',
      '1',
      '-screen',
      '0',
      `${screen.width}x${screen.height}x24`,
      '-nolisten',
      'tcp',
    ]);
    this.child = child;
    let announced: string | undefined;
    // Read in the background so the wait below stays one uniform deadline-bounded poll: a stream read
    // cannot be raced against a fake clock, but a variable it fills can be polled by one. A rejection
    // is recorded as an ANSWER rather than swallowed — a broken pipe is Xvfb failing to report, not a
    // reason to keep waiting for a report that can no longer arrive.
    const reading = this.firstLine(child).then(
      line => {
        announced = line.trim();
      },
      () => {
        announced = '';
      },
    );
    try {
      // Readiness is a USABLE number, not merely an answer: an Xvfb that closed its report without one
      // has almost always just died, and the exit status below is the diagnostic worth reporting.
      await awaitReady({
        what: 'Xvfb',
        child,
        ready: () => announced !== undefined && /^\d+$/.test(announced),
        timing: this.timing,
        stalled: () => (announced === undefined ? undefined : 'Xvfb did not report the display number it took'),
      });
    } catch (error) {
      this.child = undefined;
      child.kill('SIGKILL');
      throw error;
    }
    await reading;
    return `:${announced ?? ''}`;
  }

  /** The first newline-terminated line Xvfb writes, or `''` if it closed the stream without one. */
  private async firstLine(child: XvfbChild): Promise<string> {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value !== undefined) buffer += decoder.decode(value, { stream: true });
        const newline = buffer.indexOf('\n');
        if (newline >= 0) return buffer.slice(0, newline);
        if (done) return '';
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export interface BrowserLoginRuntimeOptions extends BrowserLoginTiming {
  readonly display: BrowserDisplayPort;
  /** Where the one-shot VNC password file is written. The daemon's own browser directory, so the
   *  secret never lands in a world-readable temp path. */
  readonly secretsDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly environmentSource?: Readonly<Record<string, string | undefined>>;
  readonly hostname?: string;
  readonly sshUser?: string;
  /** An operator's explicit Chrome, ahead of this platform's candidate list. */
  readonly chromeOverride?: () => string | undefined;
  /** Looked up on this host's PATH at the moment of use, for the reason `XvfbDisplayOptions`
   *  states: `undefined` is a host that has not installed it, and refuses saying so. */
  readonly x11vncExecutable?: () => string | undefined;
  readonly timeoutExecutable?: () => string | undefined;
  readonly spawn?: BrowserLoginSpawner;
  readonly run?: BrowserLoginProgramReader;
  readonly exists?: (candidate: string) => boolean;
  /** Whether anything is accepting TCP on loopback at this port. */
  readonly probePort?: (port: number) => Promise<boolean>;
  readonly freePort?: () => Promise<number>;
}

/**
 * Every host effect the human login window performs, over Node, Bun and this daemon's own state
 * home.
 *
 * The EXECUTABLES ARE INJECTED, absolute, and resolved once by the composition root — the same rule
 * `BunTmuxProcess` follows, and for the same two reasons. A `PATH` lookup inside the adapter cannot
 * be pointed at a fake by a test without putting a directory on the process's own `PATH`, and a
 * relative program name is resolved against whatever `PATH` the spawn inherits, which is not
 * necessarily the one the operator installed x11vnc onto. A host missing one refuses with a sentence
 * naming what to install rather than spawning something else that happens to answer to the name.
 */
export class NodeBrowserLoginRuntime implements BrowserLoginRuntime {
  readonly platform: NodeJS.Platform;
  readonly environmentSource: Readonly<Record<string, string | undefined>>;
  readonly hostname: string;
  readonly sshUser: string;
  private readonly timing: ReturnType<typeof resolveTiming>;
  private readonly terminateGraceMs: number;
  private readonly spawner: BrowserLoginSpawner;
  private readonly reader: BrowserLoginProgramReader;
  private readonly exists: (candidate: string) => boolean;
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly freePortOf: () => Promise<number>;

  constructor(private readonly options: BrowserLoginRuntimeOptions) {
    this.platform = options.platform ?? process.platform;
    this.environmentSource = options.environmentSource ?? process.env;
    this.hostname = options.hostname ?? osHostname();
    this.sshUser = options.sshUser ?? userInfo().username;
    this.timing = resolveTiming(options);
    this.terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TIMING.terminateGraceMs;
    this.exists = options.exists ?? (candidate => existsSync(candidate));
    this.spawner =
      options.spawn ??
      ((argv, environment) => {
        // stdio is DISCARDED, never inherited: Chrome and x11vnc are chatty, and a pipe nobody
        // drains fills and blocks the child mid-window.
        const child = Bun.spawn({
          cmd: [...argv],
          env: definedEnvironment(environment),
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
        return { pid: child.pid, exited: child.exited, kill: signal => child.kill(signal) };
      });
    this.reader =
      options.run ??
      (async argv => {
        const child = Bun.spawn({ cmd: [...argv], stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return { code, stdout };
      });
    this.probePort = options.probePort ?? (port => loopbackAccepts(port));
    this.freePortOf = options.freePort ?? (() => loopbackFreePort());
  }

  async display(): Promise<string> {
    return await this.options.display.display();
  }

  /** Releases the display this runtime took. Registered by the composition root, not by the window:
   *  the display outlives any one window by design (see `XvfbDisplay`). */
  async close(): Promise<void> {
    await this.options.display.close();
  }

  chromeExecutable(): string {
    return selectChromeExecutable(this.platform, this.options.chromeOverride?.(), this.exists);
  }

  x11vncExecutable(): string {
    return this.required(
      this.options.x11vncExecutable?.(),
      'x11vnc was not found on this host; the login window serves its screen over a loopback VNC listener',
    );
  }

  timeoutExecutable(): string {
    return this.required(
      this.options.timeoutExecutable?.(),
      'timeout(1) was not found on this host; it is what closes the login window when its minutes run out',
    );
  }

  async chromeVersion(executable: string): Promise<string> {
    const { code, stdout } = await this.reader([executable, '--version']);
    const version = stdout.split('\n', 1)[0]?.trim() ?? '';
    // A version is not cosmetic: the profile store refuses a profile primed by a NEWER Chrome, so a
    // blank answer here would let a downgrade silently reuse a profile it can corrupt.
    if (code !== 0 || version === '') {
      throw new BrowserControlError('launch_failed', `${executable} did not report a version (status ${code})`);
    }
    return version;
  }

  spawn(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>): BrowserLoginChild {
    return this.spawner(argv, environment);
  }

  async freePort(): Promise<number> {
    return await this.freePortOf();
  }

  /**
   * Writes the VNC password where x11vnc will read it once and delete it.
   *
   * The directory is 0700 and the file 0600, set explicitly after the write as well as at creation:
   * the mode argument only applies when the file does not already exist, and a leftover file from a
   * crashed window must not keep whatever mode it had.
   */
  async writePassword(password: string): Promise<string> {
    await mkdir(this.options.secretsDirectory, { recursive: true, mode: 0o700 });
    const file = join(this.options.secretsDirectory, vncPasswordName);
    await writeFile(file, `${password}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return file;
  }

  /**
   * Waits for Chrome to have started inside the profile it was pointed at.
   *
   * `SingletonLock` is the only signal Chrome gives when it is launched without a debugging port,
   * and the login window is deliberately launched without one. It is written early — before the
   * window is mapped — and that is sufficient here, because x11vnc attaches to the DISPLAY rather
   * than to a window: a viewer that connects a moment early sees the screen the window then appears
   * on, and a Chrome that failed to start is reported as the launch failure it is.
   */
  async waitForChrome(profile: string, child: BrowserLoginChild): Promise<void> {
    await awaitReady({
      what: 'Chrome',
      child,
      ready: () => this.exists(join(profile, chromeStartupMarker)),
      timing: this.timing,
    });
  }

  async waitForVnc(port: number, child: BrowserLoginChild): Promise<void> {
    await awaitReady({
      what: 'the VNC server',
      child,
      ready: async () => await this.probePort(port),
      timing: this.timing,
    });
  }

  async removePassword(file: string): Promise<void> {
    // `force` because x11vnc's `-passwdfile rm:` has usually already deleted it, and a window that
    // closed cleanly must not report a failure for the file doing exactly what it was asked to.
    await rm(file, { force: true });
  }

  async terminateChrome(child: BrowserLoginChild): Promise<void> {
    await this.terminate(child);
  }

  async terminateVnc(child: BrowserLoginChild): Promise<void> {
    await this.terminate(child);
  }

  now(): number {
    return this.timing.now();
  }

  private required(value: string | undefined, refusal: string): string {
    if (value === undefined) throw new BrowserControlError('launch_failed', refusal);
    return value;
  }

  /**
   * SIGTERM, a grace period, then SIGKILL — and no await after the kill.
   *
   * A killed child is gone whether or not this process gets to reap it, and awaiting its exit would
   * let one unreapable process hang every later `start` and `stop` behind the window's serial queue.
   */
  private async terminate(child: BrowserLoginChild): Promise<void> {
    let exited = false;
    void child.exited.then(
      () => {
        exited = true;
      },
      () => {
        exited = true;
      },
    );
    child.kill('SIGTERM');
    const deadline = this.timing.now() + this.terminateGraceMs;
    while (!exited && this.timing.now() < deadline) await this.timing.sleep(this.timing.pollIntervalMs);
    if (!exited) child.kill('SIGKILL');
  }
}

/** A free loopback TCP port, taken by binding one and releasing it. */
async function loopbackFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(error));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port === 0 ? reject(new Error('the host did not report a bound port')) : resolve(port)));
    });
  });
}

/** Whether a loopback connection to this port is accepted right now. */
async function loopbackAccepts(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}
