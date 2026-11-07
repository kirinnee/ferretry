import type { Clock, WorkerHandle } from '@ferretry/kernel/contract';
import type { BrowserElementTarget, BrowserScreenshotFormat, BrowserTarget } from '../pages/wire/target.ts';
import type { BrowserInputEvent, BrowserPageSnapshot, BrowserScreencastFrame, BrowserViewport } from '../pages/wire/browser.ts';
import type { BrowserPageLifecycleReply, BrowserPageLifecycleRequest } from '../pages/wire/page-lifecycle.ts';
import type { CopyElementPart } from '../pages/copy-contracts.ts';
import { InputTargetFactsSchema } from '@ferretry/core-vault/contract';
import { COPY_VALUE_MAX_BYTES } from '../pages/copy-contracts.ts';
import { BROWSER_COPY_WORKER_METHODS, type BrowserCopyRead } from '../pages/copy-contracts.ts';
import { BROWSER_INPUT_TEXT_MAX_CHARS, BROWSER_INPUT_WORKER_METHODS, type BrowserInputClearJob, type BrowserInputClearOutcome, type BrowserInputDocument, type BrowserInputFacts, type BrowserInputFieldPointer, type BrowserInputObservation, type BrowserInputOutcome, type BrowserInputShot, type BrowserInputValue, type BrowserPushNumberRead } from '../pages/input-contracts.ts';
import { type BrowserAutomation, type BrowserPageActed } from '../pages/automation.ts';
import { type BrowserClickOptions, type BrowserReadOptions, type BrowserScreenshotOptions, type BrowserTypeOptions, type BrowserUploadMode } from '../pages/page-acts.ts';
import { BrowserFrameGovernor } from '../stream/frame-governor.ts';
import { BrowserTransportError, boundedReadText, boundedScreenshot, encodeWorkerRequest, normalizeLifecycleReply, normalizeWorkerActionSnapshot, normalizeWorkerDialog, normalizeWorkerSnapshot, normalizeWorkerStaged, parseWorkerLine, WorkerLineAssembler, type WorkerSnapshotResult, type WorkerStagedFile } from './protocol.ts';
import { type FrameClock } from '../stream/contracts.ts';
import { PAGE_SCRIPT_ORIGIN_MAX_CHARS, type PageScript } from './page-script.ts';
import { type PointerAct } from '../pages/pointer-acts.ts';
import { KernelFrameClock } from '../stream/frame-clock.ts';

/** What the worker saw of a page's fields, checked against the protocol before it is believed. */
function parseObservation(raw: unknown): BrowserInputObservation {
  const observation = (raw as { observation?: unknown } | null)?.observation as Record<string, unknown> | undefined;
  if (observation?.ok === false && typeof observation.missing === 'string')
    return { ok: false, missing: observation.missing.slice(0, 64) };
  if (observation?.ok === false && typeof observation.ambiguous === 'string')
    return { ok: false, ambiguous: observation.ambiguous.slice(0, 64) };
  const facts = InputTargetFactsSchema.safeParse(observation?.facts);
  if (observation?.ok === true && facts.success && facts.data.kind === 'page')
    return { ok: true, facts: facts.data };
  throw new BrowserTransportError(
    'upstream_failed',
    'the browser described the fields in a form Ferretry does not accept',
    502,
  );
}

/** The longest a document id or an origin in a copy read may be, as the input bridge bounds them. */
const COPY_READ_LIMITS = { origin: 256, navigationId: 128 } as const;

/**
 * A copy read, checked before it is believed: a value no longer than one character over the cap, the page's and
 * the frame's origin and the document, or one of the two refusals. A malformed answer is refused in words that
 * quote none of it, because it may carry a value.
 */
function parseCopyRead(raw: unknown): BrowserCopyRead {
  const read = (raw ?? {}) as Record<string, unknown>;
  if (read.ok === false && (read.reason === 'missing' || read.reason === 'empty' || read.reason === 'changed'))
    return { ok: false, reason: read.reason };
  const bounded = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && value !== '' && value.length <= limit;
  if (
    read.ok === true &&
    bounded(read.value, COPY_VALUE_MAX_BYTES + 1) &&
    bounded(read.origin, COPY_READ_LIMITS.origin) &&
    bounded(read.frameOrigin, COPY_READ_LIMITS.origin) &&
    bounded(read.navigationId, COPY_READ_LIMITS.navigationId)
  )
    return {
      ok: true,
      value: read.value,
      origin: read.origin,
      frameOrigin: read.frameOrigin,
      navigationId: read.navigationId,
      ...(read.editable === true ? { editable: true as const } : {}),
    };
  throw new BrowserTransportError(
    'upstream_failed',
    'the browser answered the copy in a form Ferretry does not accept',
    502,
  );
}

const PUSH_NUMBER_PROVIDERS: ReadonlySet<unknown> = new Set(['okta', 'microsoft', 'google', 'duo']);
const PUSH_NUMBER_MISSING: ReadonlySet<unknown> = new Set(['none-found', 'changed']);
const PUSH_NUMBER_KEYS: ReadonlySet<string> = new Set(['origin', 'navigationId', 'provider', 'number', 'missing']);
const PUSH_NUMBER_VALUE_KEYS: ReadonlySet<string> = new Set(['value', 'from', 'frameOrigin']);

/**
 * A push-number read, checked before it is believed: exactly the shape `BrowserPushNumberRead` names, a number of one
 * to six digits from a known source, and either a number or why there is none, never both. A malformed answer is
 * refused in words that quote none of it.
 */
export function parsePushNumberRead(raw: unknown): BrowserPushNumberRead {
  const refuse = (): never => {
    throw new BrowserTransportError(
      'upstream_failed',
      'the browser answered the push number in a form Ferretry does not accept',
      502,
    );
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const bounded = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && value !== '' && value.length <= limit;
  if (!object(raw) || Object.keys(raw).some(key => !PUSH_NUMBER_KEYS.has(key))) return refuse();
  const { origin, navigationId, provider, number, missing } = raw;
  if (!bounded(origin, COPY_READ_LIMITS.origin) || !bounded(navigationId, COPY_READ_LIMITS.navigationId))
    return refuse();
  if (provider !== undefined && !PUSH_NUMBER_PROVIDERS.has(provider)) return refuse();
  if ((number === undefined) === (missing === undefined)) return refuse();
  const base = {
    origin,
    navigationId,
    ...(provider === undefined ? {} : { provider: provider as NonNullable<BrowserPushNumberRead['provider']> }),
  };
  if (missing !== undefined)
    return PUSH_NUMBER_MISSING.has(missing)
      ? { ...base, missing: missing as NonNullable<BrowserPushNumberRead['missing']> }
      : refuse();
  if (!object(number) || Object.keys(number).some(key => !PUSH_NUMBER_VALUE_KEYS.has(key))) return refuse();
  const { value, from, frameOrigin } = number;
  if (typeof value !== 'string' || !/^[0-9]{1,6}$/u.test(value)) return refuse();
  if (!PUSH_NUMBER_PROVIDERS.has(from) || !bounded(frameOrigin, COPY_READ_LIMITS.origin)) return refuse();
  return {
    ...base,
    number: { value, from: from as NonNullable<BrowserPushNumberRead['number']>['from'], frameOrigin },
  };
}

/** A field shot: a bounded PNG and a finite clip, or a refusal. */
function parseShot(raw: unknown): BrowserInputShot {
  const shot = (raw as { shot?: unknown } | null)?.shot as Record<string, unknown> | undefined;
  const clip = shot?.clip as Record<string, unknown> | undefined;
  const numbers = ['x', 'y', 'w', 'h'].map(key => clip?.[key]);
  if (
    typeof shot?.pngBase64 === 'string' &&
    shot.pngBase64.length > 0 &&
    shot.pngBase64.length <= MAX_INPUT_SHOT_CHARS &&
    /^[A-Za-z0-9+/]+=*$/u.test(shot.pngBase64) &&
    numbers.every(value => typeof value === 'number' && Number.isFinite(value))
  ) {
    const [x, y, w, h] = numbers as number[];
    return { pngBase64: shot.pngBase64, clip: { x: x as number, y: y as number, w: w as number, h: h as number } };
  }
  throw new BrowserTransportError('upstream_failed', 'the browser sent no usable picture of the fields', 502);
}

/** The most a field shot may be as base64: a 900px-square PNG is far under it. */
const MAX_INPUT_SHOT_CHARS = 4_000_000;

/** A worker answer as a snapshot, with the dialog the acted page is waiting on beside it. */
function acted(raw: unknown): BrowserPageActed {
  const snapshot = unwrap(normalizeWorkerActionSnapshot(raw));
  const dialog = normalizeWorkerDialog(raw);
  return dialog === undefined ? snapshot : { ...snapshot, dialog };
}

export const READY_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface WorkerClientOptions {
  /**
   * Starts the browser worker: a Bun worker thread from this package (`kernel.workers.start`, §7.4). It reads one
   * `{ kind: 'start' }` message, then one JSON request line per message, and posts JSON record lines back.
   */
  readonly start: () => WorkerHandle;
  /**
   * How the worker reaches Chrome. Opaque to the client. The agent browser passes `CDP_PIPE_ENDPOINT` together
   * with {@link cdpPipe}; the scripted test worker reads it as a behaviour.
   */
  readonly endpoint: string;
  /**
   * The daemon's ends of Chrome's DevTools pipe. The worker thread shares this process, so it reads and writes
   * these descriptors itself; the caller still closes them once the worker is gone.
   */
  readonly cdpPipe?: CdpPipeEnds;
  /** The daemon-owned directory the worker stages downloads and PDFs in; without one it stages nothing. */
  readonly stageDirectory?: string;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /** Ceiling on one newline-free worker record; the default sizes a full screenshot reply. */
  readonly maxProtocolLineChars?: number;
  /** The kernel's clock: frame pacing and every timeout (a test hands in a driven one). */
  readonly clock: Clock;
  /** Floor on the interval between frames handed to viewers. */
  readonly frameIntervalMs?: number;
}

/** The parent ends of Chrome's `--remote-debugging-pipe`, as `Bun.spawn` returns them in `stdio[3]` and `stdio[4]`. */
export interface CdpPipeEnds {
  /** Chrome reads this pipe on its fd 3. */
  readonly toChrome: number;
  /** Chrome writes this pipe on its fd 4. */
  readonly fromChrome: number;
}

interface PageCast {
  readonly listeners: Set<(frame: BrowserScreencastFrame) => void>;
  readonly governor: BrowserFrameGovernor<BrowserScreencastFrame>;
  token: string;
  start?: Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * The browser worker thread as the client drives it: request lines in, record text out, and an end it can wait on.
 * Built from the kernel's {@link WorkerHandle}; a test hands in its own.
 */
interface WorkerChannel {
  write(line: string): void;
  onText(listener: (text: string) => void): void;
  readonly exited: Promise<number>;
  stop(): void;
}

function workerChannel(handle: WorkerHandle): WorkerChannel {
  const exit = deferred<number>();
  let stopped = false;
  return {
    write: line => handle.post(line),
    onText: listener => {
      handle.onMessage(message => {
        if (typeof message === 'string') listener(message);
        else if (
          typeof message === 'object' &&
          message !== null &&
          (message as { readonly type?: unknown }).type === 'exit'
        )
          exit.resolve(0);
      });
    },
    exited: exit.promise,
    stop: () => {
      if (stopped) return;
      stopped = true;
      void handle.terminate().finally(() => exit.resolve(0));
    },
  };
}

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
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => BrowserTransportError,
  clock: FrameClock,
): Promise<T> {
  let timer: { cancel(): void } | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = clock.schedule(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    timer?.cancel();
  }
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
  /** One screencast per page, each with its own pacing, listeners and acknowledgements. */
  private readonly casts = new Map<string, PageCast>();
  private readonly clock: FrameClock;
  private readonly frameIntervalMs: number | undefined;
  private screencastSessions = 0;
  private readyState: 'pending' | 'ready' | 'failed' = 'pending';
  private closed = false;
  private closing = false;
  private readonly assembler: WorkerLineAssembler;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  readonly unexpectedExit = this.exit.promise;

  private constructor(
    private readonly child: WorkerChannel,
    options: WorkerClientOptions,
  ) {
    this.assembler = new WorkerLineAssembler(options.maxProtocolLineChars);
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    this.clock = new KernelFrameClock(options.clock);
    this.frameIntervalMs = options.frameIntervalMs;
    this.readOutput();
    void this.child.exited.then(code => this.onExit(code));
  }

  /** Spawns the worker and waits for its ready record, killing it if that never arrives. */
  static async connect(options: WorkerClientOptions): Promise<BrowserWorkerClient> {
    const child = workerChannel(options.start());
    child.write(
      JSON.stringify({
        kind: 'start',
        endpoint: options.endpoint,
        ...(options.stageDirectory === undefined ? {} : { stageDirectory: options.stageDirectory }),
        ...(options.cdpPipe === undefined ? {} : { cdpPipe: options.cdpPipe }),
      }),
    );
    const client = new BrowserWorkerClient(child, options);
    try {
      await withTimeout(
        client.ready.promise,
        options.readyTimeoutMs ?? READY_TIMEOUT_MS,
        () => new BrowserTransportError('launch_failed', 'browser worker did not become ready', 503),
        client.clock,
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

  navigate(pageId: string, url: string): Promise<BrowserPageActed> {
    return this.action('navigate', { pageId, url });
  }

  click(pageId: string, target: BrowserTarget, options: BrowserClickOptions = {}): Promise<BrowserPageActed> {
    return this.action('click', { pageId, target, ...options });
  }

  type(
    pageId: string,
    target: BrowserElementTarget,
    text: string,
    options: BrowserTypeOptions = {},
  ): Promise<BrowserPageActed> {
    return this.action('type', { pageId, target, text, ...options });
  }

  pointer(pageId: string, act: PointerAct): Promise<BrowserPageActed> {
    return this.action('pointer', { pageId, act });
  }

  async read(pageId: string, options: BrowserReadOptions = {}): Promise<BrowserPageActed & { readonly text: string }> {
    const raw = await this.request('read', { pageId, ...options });
    return { ...acted(raw), text: boundedReadText(raw) };
  }

  async screenshot(
    pageId: string,
    options: BrowserScreenshotOptions = {},
  ): Promise<
    BrowserPageActed & {
      readonly screenshotBase64: string;
      readonly screenshotFormat: BrowserScreenshotFormat;
    }
  > {
    const raw = await this.request('screenshot', { pageId, ...options });
    const format = (raw as { screenshotFormat?: unknown }).screenshotFormat;
    if (format !== 'png' && format !== 'jpeg') throw new Error('browser worker sent no screenshot format');
    return { ...acted(raw), screenshotBase64: boundedScreenshot(raw), screenshotFormat: format };
  }

  async evaluate(
    pageId: string,
    script: PageScript,
  ): Promise<BrowserPageActed & { readonly text: string; readonly scriptOrigin?: string }> {
    const raw = await this.request('evaluate', {
      pageId,
      source: script.source,
      ...(script.target === undefined ? {} : { target: script.target }),
      ...(script.timeoutMs === undefined ? {} : { timeoutMs: script.timeoutMs }),
    });
    // The origin of the world the script ran in, as the worker read it; the worker sends none when it could not read one (read as unknown).
    const origin = (raw as { scriptOrigin?: unknown }).scriptOrigin;
    return {
      ...acted(raw),
      text: boundedReadText(raw),
      ...(typeof origin === 'string' && origin.length <= PAGE_SCRIPT_ORIGIN_MAX_CHARS ? { scriptOrigin: origin } : {}),
    };
  }

  upload(
    pageId: string,
    target: BrowserElementTarget,
    paths: readonly string[],
    mode: BrowserUploadMode,
  ): Promise<BrowserPageActed> {
    return this.action('upload', { pageId, target, paths, mode });
  }

  async download(
    pageId: string,
    downloadId?: string,
  ): Promise<BrowserPageActed & { readonly staged: WorkerStagedFile }> {
    return await this.staged('download', { pageId, ...(downloadId === undefined ? {} : { downloadId }) });
  }

  async pdf(pageId: string): Promise<BrowserPageActed & { readonly staged: WorkerStagedFile }> {
    return await this.staged('pdf', { pageId });
  }

  private async staged(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<BrowserPageActed & { readonly staged: WorkerStagedFile }> {
    const raw = await this.request(method, params);
    const staged = normalizeWorkerStaged(raw);
    if (staged === undefined) throw new BrowserTransportError('upstream_failed', 'browser worker staged no file', 502);
    return { ...unwrap(normalizeWorkerActionSnapshot(raw)), staged };
  }

  back(pageId: string): Promise<BrowserPageActed> {
    return this.action('back', { pageId });
  }

  forward(pageId: string): Promise<BrowserPageActed> {
    return this.action('forward', { pageId });
  }

  reload(pageId: string): Promise<BrowserPageActed> {
    return this.action('reload', { pageId });
  }

  async location(pageId?: string): Promise<BrowserPageSnapshot> {
    return unwrap(normalizeWorkerSnapshot(await this.request('location', pageId === undefined ? {} : { pageId })));
  }

  newPage(options: { readonly url?: string; readonly incognito?: boolean }): Promise<BrowserPageActed> {
    return this.action('newPage', {
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.incognito === true ? { incognito: true } : {}),
    });
  }

  closePage(pageId: string): Promise<BrowserPageActed> {
    this.casts.get(pageId)?.governor.dispose();
    this.casts.delete(pageId);
    return this.action('closePage', { pageId });
  }

  resize(pageId: string, viewport: BrowserViewport): Promise<BrowserPageActed> {
    return this.action('resize', { pageId, width: viewport.width, height: viewport.height });
  }

  /**
   * The push number a page shows (push-number-read.ts), as a provider's own challenge view shows it. Believed only in
   * its exact shape; anything else is refused in words that quote none of it.
   */
  async pushNumberRead(pageId: string): Promise<BrowserPushNumberRead> {
    const raw = await this.request(BROWSER_INPUT_WORKER_METHODS.pushNumber, { pageId });
    return parsePushNumberRead((raw as { read?: unknown } | null)?.read);
  }

  async inputDocument(pageId: string): Promise<BrowserInputDocument> {
    const raw = await this.request(BROWSER_INPUT_WORKER_METHODS.document, { pageId });
    const navigationId = ((raw as { document?: { navigationId?: unknown } } | null)?.document ?? {}).navigationId;
    if (typeof navigationId !== 'string' || navigationId === '' || navigationId.length > 128)
      throw new BrowserTransportError('upstream_failed', 'the browser did not say which document the page shows', 502);
    const host = (raw as { document?: { host?: unknown } } | null)?.document?.host;
    return typeof host === 'string' && host !== '' && host.length <= 260 ? { navigationId, host } : { navigationId };
  }

  /** The page's visible text, for the daemon's own look for a just-typed value. A malformed answer is refused. */
  async inputText(pageId: string): Promise<string> {
    const raw = await this.request(BROWSER_INPUT_WORKER_METHODS.text, { pageId });
    const text = (raw as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.length > BROWSER_INPUT_TEXT_MAX_CHARS * 3 + 2)
      throw new BrowserTransportError('upstream_failed', 'the browser did not answer with the page text', 502);
    return text;
  }

  /**
   * One element's text, value or attribute, for a secure copy. The value rides in this answer only; a malformed
   * answer is refused in words that quote none of it.
   */
  async copyRead(
    pageId: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute?: string,
  ): Promise<BrowserCopyRead> {
    const raw = await this.request(BROWSER_COPY_WORKER_METHODS.read, {
      pageId,
      target,
      part,
      ...(attribute === undefined ? {} : { attribute }),
    });
    return parseCopyRead((raw as { read?: unknown } | null)?.read);
  }

  async inputObserve(pageId: string, fields: readonly BrowserInputFieldPointer[]): Promise<BrowserInputObservation> {
    return parseObservation(await this.request(BROWSER_INPUT_WORKER_METHODS.observe, { pageId, fields }));
  }

  async inputRefind(
    pageId: string,
    expected: BrowserInputFacts,
    fields: readonly BrowserInputFieldPointer[],
  ): Promise<BrowserInputObservation> {
    return parseObservation(await this.request(BROWSER_INPUT_WORKER_METHODS.refind, { pageId, expected, fields }));
  }

  async inputShot(pageId: string, facts: BrowserInputFacts): Promise<BrowserInputShot> {
    return parseShot(await this.request(BROWSER_INPUT_WORKER_METHODS.shot, { pageId, facts }));
  }

  /**
   * The one write of owner-supplied values. The values ride only in this request's params; the answer is a word.
   * Anything but one of the four words (a crash, a timeout, a garbled line) is `uncertain`: the write may have
   * begun, so it is never repeated.
   */
  async inputType(
    pageId: string,
    expected: BrowserInputFacts,
    values: readonly BrowserInputValue[],
    submit: boolean,
  ): Promise<BrowserInputOutcome> {
    try {
      const raw = await this.request(BROWSER_INPUT_WORKER_METHODS.type, { pageId, expected, values, submit });
      const outcome = (raw as { outcome?: unknown } | null)?.outcome;
      return outcome === 'typed' || outcome === 'target_changed' || outcome === 'target_gone' ? outcome : 'uncertain';
    } catch {
      return 'uncertain';
    }
  }

  /**
   * A grant fill arms its `pagehide` clear before the write. A worker from before this call refuses the unknown method,
   * and that, a failure or any odd answer is `refused`: the daemon then types nothing.
   */
  async inputArm(
    pageId: string,
    expected: BrowserInputFacts,
    fieldIds: readonly string[],
  ): Promise<'armed' | 'refused'> {
    try {
      const raw = await this.request(BROWSER_INPUT_WORKER_METHODS.arm, { pageId, expected, fieldIds });
      return (raw as { outcome?: unknown } | null)?.outcome === 'armed' ? 'armed' : 'refused';
    } catch {
      return 'refused';
    }
  }

  /**
   * A grant fill's check before its page hold ends: the job names nodes, never a value. Any failure or odd answer is
   * `unknown`, which stops the line.
   */
  async inputClear(pageId: string, job: BrowserInputClearJob): Promise<BrowserInputClearOutcome> {
    try {
      const raw = await this.request(BROWSER_INPUT_WORKER_METHODS.clear, { pageId, job });
      const outcome = (raw as { outcome?: unknown } | null)?.outcome;
      return outcome === 'cleared' || outcome === 'moved' ? outcome : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** The dummy probe; any failure or odd answer is `aborted`, which only keeps the lock long. */
  async inputProbe(
    pageId: string,
    expected: BrowserInputFacts,
    fieldIds: readonly string[],
    dummy: string,
  ): Promise<'hidden' | 'shown' | 'aborted'> {
    try {
      const raw = await this.request(BROWSER_INPUT_WORKER_METHODS.probe, { pageId, expected, fieldIds, dummy });
      const outcome = (raw as { outcome?: unknown } | null)?.outcome;
      return outcome === 'hidden' || outcome === 'shown' ? outcome : 'aborted';
    } catch {
      return 'aborted';
    }
  }

  /**
   * Joins ONE page's screencast. Viewers of the same page that arrive while its start is still in
   * flight await the SAME request: reporting success off the back of an attempt that has not landed
   * yet hands the second viewer a permanently black viewport and no error to explain it. Viewers of
   * different pages each get their own stream and never see each other's frames.
   */
  async startScreencast(
    pageId: string,
    viewport: BrowserViewport,
    listener: (frame: BrowserScreencastFrame) => void,
  ): Promise<void> {
    const cast = this.castOf(pageId);
    cast.listeners.add(listener);
    if (cast.start === undefined) {
      cast.governor.bind(this.newToken(cast));
      cast.start = this.request('startScreencast', { pageId, width: viewport.width, height: viewport.height }).then(
        () => undefined,
      );
    }
    const start = cast.start;
    try {
      await start;
    } catch (error) {
      cast.listeners.delete(listener);
      // Every viewer waiting on this attempt fails together, and the next join starts a fresh one.
      if (cast.start === start) {
        cast.start = undefined;
        cast.governor.stop();
      }
      throw error;
    }
  }

  /** Leaves one page's screencast; the page stops streaming when its last viewer leaves. */
  async stopScreencast(pageId: string, listener: (frame: BrowserScreencastFrame) => void): Promise<void> {
    const cast = this.casts.get(pageId);
    if (cast === undefined || !cast.listeners.delete(listener) || cast.listeners.size > 0) return;
    cast.governor.dispose();
    this.casts.delete(pageId);
    await this.request('stopScreencast', { pageId });
  }

  async dispatchInput(pageId: string, input: BrowserInputEvent): Promise<void> {
    await this.request('dispatchInput', { pageId, input });
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
    await withTimeout(this.request('close', {}), deadline, () => shutdownExpired(), this.clock).catch(
      () => undefined,
    );
    this.closed = true;
    this.disposeCasts();
    await this.terminate(deadline);
  }

  /**
   * Ends the worker thread and waits for it to be gone. A thread cannot trap a terminate the way a child process
   * trapped SIGTERM, so one terminate is the outcome; the bound still applies.
   */
  private async terminate(deadline: number): Promise<void> {
    this.child.stop();
    if (await this.exitedWithin(deadline)) return;
    throw new BrowserTransportError('upstream_failed', 'browser worker could not be terminated', 504);
  }

  private async exitedWithin(deadline: number): Promise<boolean> {
    return withTimeout(
      this.child.exited.then(() => true),
      deadline,
      () => shutdownExpired(),
      this.clock,
    ).catch(() => false);
  }

  async lifecycle(
    pageId: string,
    request: BrowserPageLifecycleRequest,
  ): Promise<BrowserPageActed & { readonly lifecycle: BrowserPageLifecycleReply }> {
    const raw = await this.request('lifecycle', { pageId, request });
    return { ...acted(raw), lifecycle: normalizeLifecycleReply(raw) };
  }

  private async action(method: string, params: Readonly<Record<string, unknown>>): Promise<BrowserPageActed> {
    return acted(await this.request(method, params));
  }

  private async request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) throw new BrowserTransportError('not_running', 'browser worker is closed', 409);
    const id = this.nextId;
    this.nextId += 1;
    const result = deferred<unknown>();
    this.pending.set(id, result);
    try {
      this.child.write(encodeWorkerRequest(id, method, params));
      return await withTimeout(
        result.promise,
        this.requestTimeoutMs,
        () => new BrowserTransportError('upstream_failed', `browser ${method} timed out`, 504),
        this.clock,
      );
    } finally {
      this.pending.delete(id);
    }
  }

  private readOutput(): void {
    this.child.onText(text => {
      if (this.closed && this.readyState !== 'pending') return;
      const batch = this.assembler.push(text);
      for (const line of batch.lines) this.onEvent(line);
      if (batch.overflowed) this.failProtocol();
    });
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
      case 'frame': {
        // A frame is routed to its OWN page's stream, and one for a page nobody streams is discarded:
        // a frame nobody asked for still costs every viewer a repaint.
        const cast = this.casts.get(event.frame.pageId);
        if (cast === undefined) return;
        cast.governor.capture(cast.token, event.frame, () => this.acknowledgeFrame(event.ackId));
        return;
      }
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

  private newToken(cast: PageCast): string {
    this.screencastSessions += 1;
    cast.token = `screencast-${String(this.screencastSessions)}`;
    return cast.token;
  }

  /**
   * One page's stream. Frames reach its viewers through its own governor, so the pace the browser
   * captures that page at follows the real end-to-end path: a frame is acknowledged only once it has
   * actually been handed to every viewer of that page.
   */
  private castOf(pageId: string): PageCast {
    const existing = this.casts.get(pageId);
    if (existing !== undefined) return existing;
    const listeners = new Set<(frame: BrowserScreencastFrame) => void>();
    const cast: PageCast = {
      listeners,
      token: '',
      governor: new BrowserFrameGovernor<BrowserScreencastFrame>(
        this.clock,
        {
          write: frame => {
            for (const listener of [...listeners]) {
              try {
                listener(frame);
              } catch {
                // A failing viewer must never stop the reader: agent actions share this worker and
                // have to keep resolving.
              }
            }
            // Listeners are synchronous, so the sink is never congested; pacing is the whole job here.
            return true;
          },
        },
        {
          ...(this.frameIntervalMs === undefined ? {} : { minIntervalMs: this.frameIntervalMs }),
          // An acknowledgement the worker refused means this capture window is unusable. Rebinding
          // discards the stale window so later frames flow, instead of wedging behind
          // acknowledgements nobody will ever take.
          onAcknowledgementRejected: token => {
            if (token === cast.token && !this.closed) cast.governor.bind(this.newToken(cast));
          },
        },
      ),
    };
    this.casts.set(pageId, cast);
    return cast;
  }

  private disposeCasts(): void {
    for (const cast of this.casts.values()) cast.governor.dispose();
    this.casts.clear();
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
    this.disposeCasts();
    if (launching) {
      this.readyState = 'failed';
      this.ready.reject(error);
    } else {
      // Stopped by a protocol violation rather than a normal close, so anything waiting on the exit
      // signal must not hang.
      this.exit.resolve(-1);
    }
    this.rejectPending(error);
    this.child.stop();
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
