import { dirname } from 'node:path';
import type {
  BrowserInputEvent,
  BrowserPageActionSnapshot,
  BrowserPageSnapshot,
  BrowserScreencastFrame,
  BrowserViewport,
} from '@ferretry/protocol';
import {
  type BrowserAutomation,
  BrowserFrameGovernor,
  BrowserTransportError,
  type FrameClock,
  WorkerLineAssembler,
  type WorkerSnapshotResult,
  boundedReadText,
  boundedScreenshot,
  encodeWorkerRequest,
  normalizeWorkerActionSnapshot,
  normalizeWorkerSnapshot,
  parseWorkerLine,
} from '../../../lib/index.ts';
import { SystemFrameClock } from './system-frame-clock.ts';

export const READY_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const SHUTDOWN_TIMEOUT_MS = 2_000;

/** Only the variables a browser needs; nothing else about this host leaks into the child. */
const FORWARDED_ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL'] as const;

export interface WorkerClientOptions {
  /** Runtime that executes the worker entry, e.g. a Node binary. */
  readonly runtime: string;
  /** Absolute path to the worker script. */
  readonly workerEntry: string;
  /** Argument the worker connects to; opaque to the client. */
  readonly endpoint: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /** Ceiling on one newline-free worker record; the default sizes a full screenshot reply. */
  readonly maxProtocolLineChars?: number;
  /** Time source for frame pacing; the real timer wheel unless a test injects its own. */
  readonly clock?: FrameClock;
  /** Floor on the interval between frames handed to viewers. */
  readonly frameIntervalMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

type ChildProcess = ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'ignore'>>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A timeout that is always cleared, so no pending request can keep the runtime alive. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => BrowserTransportError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function workerEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const key of FORWARDED_ENVIRONMENT) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  // A browser must never route loopback traffic through a proxy the host happens to configure.
  environment['NO_PROXY'] = '127.0.0.1,localhost,::1';
  environment['no_proxy'] = environment['NO_PROXY'];
  return environment;
}

function shutdownExpired(): BrowserTransportError {
  return new BrowserTransportError('upstream_failed', 'browser worker did not exit', 504);
}

function unwrap<TSnapshot>(result: WorkerSnapshotResult<TSnapshot>): TSnapshot {
  if (!result.ok) throw new BrowserTransportError('upstream_failed', result.message, 502);
  return result.value;
}

/**
 * Drives a browser worker child over JSON lines: one request per line out, replies, frames and
 * lifecycle records in. Every protocol decision lives in the domain; this owns the child, the pipes
 * and the clocks.
 */
export class BrowserWorkerClient implements BrowserAutomation {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly ready = deferred<void>();
  private readonly exit = deferred<number>();
  private readonly frameListeners = new Set<(frame: BrowserScreencastFrame) => void>();
  private readonly governor: BrowserFrameGovernor<BrowserScreencastFrame>;
  private screencastStart?: Promise<void>;
  private screencastToken = '';
  private screencastSessions = 0;
  private readyState: 'pending' | 'ready' | 'failed' = 'pending';
  private closed = false;
  private closing = false;
  private readonly assembler: WorkerLineAssembler;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  readonly unexpectedExit = this.exit.promise;

  private constructor(
    private readonly child: ChildProcess,
    options: WorkerClientOptions,
  ) {
    this.assembler = new WorkerLineAssembler(options.maxProtocolLineChars);
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    // Frames reach viewers through the governor, so the pace the browser captures at follows the real
    // end-to-end path: a frame is acknowledged only once it has actually been handed to every viewer.
    this.governor = new BrowserFrameGovernor<BrowserScreencastFrame>(
      options.clock ?? new SystemFrameClock(),
      {
        write: frame => {
          this.deliverFrame(frame);
          // Listeners are synchronous, so the sink is never congested; pacing is the whole job here.
          return true;
        },
      },
      {
        ...(options.frameIntervalMs === undefined ? {} : { minIntervalMs: options.frameIntervalMs }),
        onAcknowledgementRejected: session => this.recoverScreencast(session),
      },
    );
    void this.readOutput().catch(() => undefined);
    void this.child.exited.then(code => this.onExit(code));
  }

  /** The child process id, so an operator (or a test) can confirm the worker is really gone. */
  get pid(): number {
    return this.child.pid;
  }

  /** Spawns the worker and waits for its ready record, killing it if that never arrives. */
  static async connect(options: WorkerClientOptions): Promise<BrowserWorkerClient> {
    const child = Bun.spawn([options.runtime, options.workerEntry, options.endpoint], {
      cwd: options.cwd ?? dirname(options.workerEntry),
      env: workerEnvironment(options.environment ?? {}),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const client = new BrowserWorkerClient(child, options);
    try {
      await withTimeout(
        client.ready.promise,
        options.readyTimeoutMs ?? READY_TIMEOUT_MS,
        () => new BrowserTransportError('launch_failed', 'browser worker did not become ready', 503),
      );
      return client;
    } catch (error) {
      client.closed = true;
      // A worker that failed to announce itself may already have a browser running: escalate rather
      // than firing one signal and hoping.
      await client.terminate(options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
      throw error;
    }
  }

  navigate(url: string): Promise<BrowserPageActionSnapshot> {
    return this.action('navigate', { url });
  }

  click(selector: string): Promise<BrowserPageActionSnapshot> {
    return this.action('click', { selector });
  }

  type(selector: string, text: string): Promise<BrowserPageActionSnapshot> {
    return this.action('type', { selector, text });
  }

  async read(selector?: string): Promise<BrowserPageActionSnapshot & { readonly text: string }> {
    const raw = await this.request('read', selector === undefined ? {} : { selector });
    return { ...unwrap(normalizeWorkerActionSnapshot(raw)), text: boundedReadText(raw) };
  }

  async screenshot(): Promise<BrowserPageActionSnapshot & { readonly screenshotBase64: string }> {
    const raw = await this.request('screenshot', {});
    return { ...unwrap(normalizeWorkerActionSnapshot(raw)), screenshotBase64: boundedScreenshot(raw) };
  }

  back(): Promise<BrowserPageActionSnapshot> {
    return this.action('back', {});
  }

  forward(): Promise<BrowserPageActionSnapshot> {
    return this.action('forward', {});
  }

  reload(): Promise<BrowserPageActionSnapshot> {
    return this.action('reload', {});
  }

  async location(): Promise<BrowserPageSnapshot> {
    return unwrap(normalizeWorkerSnapshot(await this.request('location', {})));
  }

  newPage(url?: string): Promise<BrowserPageActionSnapshot> {
    return this.action('newPage', url === undefined ? {} : { url });
  }

  activatePage(pageId: string): Promise<BrowserPageActionSnapshot> {
    return this.action('activatePage', { pageId });
  }

  closePage(pageId: string): Promise<BrowserPageActionSnapshot> {
    return this.action('closePage', { pageId });
  }

  resize(viewport: BrowserViewport): Promise<BrowserPageActionSnapshot> {
    return this.action('resize', { width: viewport.width, height: viewport.height });
  }

  /**
   * Joins the screencast. Viewers that arrive while the start is still in flight await the SAME
   * request: reporting success off the back of an attempt that has not landed yet hands the second
   * viewer a permanently black viewport and no error to explain it.
   */
  async startScreencast(viewport: BrowserViewport, listener: (frame: BrowserScreencastFrame) => void): Promise<void> {
    this.frameListeners.add(listener);
    if (this.screencastStart === undefined) {
      this.governor.bind(this.newScreencastSession());
      this.screencastStart = this.request('startScreencast', {
        width: viewport.width,
        height: viewport.height,
      }).then(() => undefined);
    }
    const start = this.screencastStart;
    try {
      await start;
    } catch (error) {
      this.frameListeners.delete(listener);
      // Every viewer waiting on this attempt fails together, and the next join starts a fresh one.
      if (this.screencastStart === start) {
        this.screencastStart = undefined;
        this.governor.stop();
      }
      throw error;
    }
  }

  async stopScreencast(): Promise<void> {
    if (this.frameListeners.size === 0) return;
    this.frameListeners.clear();
    this.screencastStart = undefined;
    this.governor.stop();
    await this.request('stopScreencast', {});
  }

  async dispatchInput(input: BrowserInputEvent): Promise<void> {
    await this.request('dispatchInput', { input });
  }

  /**
   * Asks the worker to shut down and makes sure it is actually gone.
   *
   * The whole shutdown — the polite request AND the exit wait — is bounded by `shutdownTimeoutMs`.
   * Charging the request timeout first would let one wedged worker hold up daemon shutdown for a
   * minute per session, which is exactly what the knob exists to prevent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    const deadline = this.shutdownTimeoutMs;
    await withTimeout(this.request('close', {}), deadline, () => shutdownExpired()).catch(() => undefined);
    this.closed = true;
    this.frameListeners.clear();
    this.governor.dispose();
    this.child.stdin.end();
    await this.terminate(deadline);
  }

  /**
   * Escalates until the child is really gone. A browser worker routinely traps SIGTERM so it can shut
   * Chrome down cleanly, so a signal is a request, not an outcome — and reporting success while the
   * process (and the browser tree it owns) is still alive is how orphans accumulate.
   */
  private async terminate(deadline: number): Promise<void> {
    if (await this.exitedWithin(deadline)) return;
    this.signal('SIGTERM');
    if (await this.exitedWithin(deadline)) return;
    this.signal('SIGKILL');
    if (await this.exitedWithin(deadline)) return;
    throw new BrowserTransportError('upstream_failed', 'browser worker could not be terminated', 504);
  }

  private async exitedWithin(deadline: number): Promise<boolean> {
    return withTimeout(
      this.child.exited.then(() => true),
      deadline,
      () => shutdownExpired(),
    ).catch(() => false);
  }

  private signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      // The negative pid targets the child's whole process group, so the browser it spawned dies with
      // it rather than being reparented and left holding a profile lock.
      process.kill(-this.child.pid, signal);
    } catch {
      // No process group (or already reaped): fall back to the child itself.
      try {
        this.child.kill(signal);
      } catch {
        // Already gone, which is the outcome we wanted.
      }
    }
  }

  private async action(method: string, params: Readonly<Record<string, unknown>>): Promise<BrowserPageActionSnapshot> {
    return unwrap(normalizeWorkerActionSnapshot(await this.request(method, params)));
  }

  private async request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) throw new BrowserTransportError('not_running', 'browser worker is closed', 409);
    const id = this.nextId;
    this.nextId += 1;
    const result = deferred<unknown>();
    this.pending.set(id, result);
    try {
      this.child.stdin.write(encodeWorkerRequest(id, method, params));
      await this.child.stdin.flush();
      return await withTimeout(
        result.promise,
        this.requestTimeoutMs,
        () => new BrowserTransportError('upstream_failed', `browser ${method} timed out`, 504),
      );
    } finally {
      this.pending.delete(id);
    }
  }

  private async readOutput(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      const batch = this.assembler.push(decoder.decode(chunk.value, { stream: true }));
      for (const line of batch.lines) this.onEvent(line);
      if (batch.overflowed) {
        this.failProtocol();
        return;
      }
      if (this.closed) return;
    }
  }

  private onEvent(line: string): void {
    const event = parseWorkerLine(line);
    switch (event.kind) {
      case 'ready':
        if (this.readyState !== 'pending') return;
        this.readyState = 'ready';
        this.ready.resolve();
        return;
      case 'fatal':
        if (this.readyState !== 'pending') return;
        this.readyState = 'failed';
        this.ready.reject(new BrowserTransportError('launch_failed', `browser worker failed: ${event.message}`, 503));
        return;
      case 'frame':
        // Frames outside a bound screencast are discarded by the governor rather than published: a
        // frame nobody asked for still costs every viewer a repaint.
        this.governor.capture(this.screencastToken, event.frame, () => this.acknowledgeFrame(event.ackId));
        return;
      case 'result':
        this.pending.get(event.id)?.resolve(event.result);
        this.pending.delete(event.id);
        return;
      case 'failure':
        this.pending
          .get(event.id)
          ?.reject(new BrowserTransportError('upstream_failed', `browser action failed: ${event.message}`, 502));
        this.pending.delete(event.id);
        return;
      default:
        return;
    }
  }

  /** Tells the worker this frame is done with, so the browser may capture the next one. */
  private async acknowledgeFrame(ackId: number | undefined): Promise<void> {
    // A worker that acknowledges its own frames sends no ack id; pacing still applies to both.
    if (ackId === undefined) return;
    await this.request('ackFrame', { ackId });
  }

  private newScreencastSession(): string {
    this.screencastSessions += 1;
    this.screencastToken = `screencast-${this.screencastSessions}`;
    return this.screencastToken;
  }

  /**
   * An acknowledgement the worker refused means this capture window is unusable. Rebinding discards
   * the stale window so later frames flow, instead of wedging behind acknowledgements nobody will
   * ever take.
   */
  private recoverScreencast(session: string): void {
    if (session !== this.screencastToken || this.closed) return;
    this.governor.bind(this.newScreencastSession());
  }

  private deliverFrame(frame: BrowserScreencastFrame): void {
    for (const listener of [...this.frameListeners]) {
      try {
        listener(frame);
      } catch {
        // A failing viewer must never stop the reader: agent actions share this worker and have to
        // keep resolving.
      }
    }
  }

  /**
   * A record with no newline in sight has no safe resynchronization point, so the worker is stopped
   * and every caller fails rather than retaining an unbounded string.
   */
  private failProtocol(): void {
    if (this.closed) return;
    const launching = this.readyState === 'pending';
    const error = new BrowserTransportError(
      launching ? 'launch_failed' : 'upstream_failed',
      'browser worker emitted an oversized protocol record',
      launching ? 503 : 502,
    );
    this.assembler.reset();
    this.closed = true;
    this.frameListeners.clear();
    if (launching) {
      this.readyState = 'failed';
      this.ready.reject(error);
    } else {
      // Stopped by a protocol violation rather than a normal close, so anything waiting on the exit
      // signal must not hang.
      this.exit.resolve(-1);
    }
    this.rejectPending(error);
    try {
      this.child.kill('SIGTERM');
    } catch {
      // The child may have exited between the protocol check and termination.
    }
  }

  private onExit(code: number): void {
    const unexpected = !this.closed && !this.closing;
    this.closed = true;
    if (this.readyState === 'pending') {
      this.readyState = 'failed';
      this.ready.reject(new BrowserTransportError('launch_failed', 'browser worker exited during launch', 503));
    }
    if (unexpected) this.exit.resolve(code);
    this.rejectPending(new BrowserTransportError('upstream_failed', 'browser worker exited', 502));
  }

  private rejectPending(error: BrowserTransportError): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const item of waiting) item.reject(error);
  }
}
