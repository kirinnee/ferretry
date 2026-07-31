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
  BrowserTransportError,
  WorkerLineAssembler,
  type WorkerSnapshotResult,
  boundedReadText,
  boundedScreenshot,
  encodeWorkerRequest,
  normalizeWorkerActionSnapshot,
  normalizeWorkerSnapshot,
  parseWorkerLine,
} from '../../../lib/index.ts';

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
    void this.readOutput().catch(() => undefined);
    void this.child.exited.then(code => this.onExit(code));
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
      client.child.kill('SIGTERM');
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

  async startScreencast(viewport: BrowserViewport, listener: (frame: BrowserScreencastFrame) => void): Promise<void> {
    const first = this.frameListeners.size === 0;
    this.frameListeners.add(listener);
    if (!first) return;
    try {
      await this.request('startScreencast', { width: viewport.width, height: viewport.height });
    } catch (error) {
      this.frameListeners.delete(listener);
      throw error;
    }
  }

  async stopScreencast(): Promise<void> {
    if (this.frameListeners.size === 0) return;
    this.frameListeners.clear();
    await this.request('stopScreencast', {});
  }

  async dispatchInput(input: BrowserInputEvent): Promise<void> {
    await this.request('dispatchInput', { input });
  }

  /** Asks the worker to shut down, then makes sure it actually did. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      await this.request('close', {});
    } catch {
      // The browser may drop its control socket before the worker can reply; termination below is
      // the bounded source of truth either way.
    }
    this.closed = true;
    this.frameListeners.clear();
    this.child.stdin.end();
    const exited = await withTimeout(
      this.child.exited.then(() => true),
      this.shutdownTimeoutMs,
      () => new BrowserTransportError('upstream_failed', 'browser worker did not exit', 504),
    ).catch(() => false);
    if (!exited) this.child.kill('SIGTERM');
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
        this.publishFrame(event.frame);
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

  private publishFrame(frame: BrowserScreencastFrame): void {
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
