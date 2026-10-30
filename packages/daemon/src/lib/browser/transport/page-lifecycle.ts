import {
  BROWSER_CONSOLE_BUFFER,
  BROWSER_CONSOLE_DEFAULT_LIMIT,
  BROWSER_CONSOLE_LEVELS,
  BROWSER_CONSOLE_MESSAGE_MAX_CHARS,
  BROWSER_DIALOG_HOLD_MS,
  BROWSER_DIALOG_MESSAGE_MAX_CHARS,
  BROWSER_NETWORK_BODY_MAX_BYTES,
  BROWSER_NETWORK_BUFFER,
  BROWSER_NETWORK_LIST_LIMIT,
  type BrowserConsoleLevel,
  type BrowserDialogAction,
  type BrowserDialogInfo,
  BrowserDialogTypeSchema,
  type BrowserElementTarget,
  type BrowserEmulation,
  type BrowserPageLifecycleReply,
  type BrowserPageLifecycleRequest,
  type BrowserResourceType,
  type BrowserWaitCondition,
} from '@ferretry/protocol';
import { browserSelectorOf } from './page-acts.ts';

/**
 * WHAT THE BROWSER WORKER KEEPS OF A PAGE'S LIFE, over the few Playwright calls it needs.
 *
 * Like `page-acts.ts`, written against structural ports so each piece is tested with a fake page and no
 * browser. The worker attaches the listeners and hands this module what they report.
 *
 * NOTHING HERE IS SCRUBBED. Text that came from a page (a dialog message, a console line, a URL, a
 * response body) leaves the worker as it is and is scrubbed by the daemon, whose vault knows the secrets.
 * What this module DOES do is drop what no agent may see at all: credential headers, and the user-info
 * of a URL.
 */

/** A page's dialog, as Playwright hands it over. */
export interface HeldDialogPort {
  type(): string;
  message(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export interface DialogTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: DialogTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface HeldDialog {
  readonly dialog: HeldDialogPort;
  readonly info: BrowserDialogInfo;
  readonly timer: unknown;
}

/**
 * The dialog each page is waiting on. A page with a dialog open cannot run script, so one that nobody
 * answers would freeze it: after {@link BROWSER_DIALOG_HOLD_MS} it is dismissed, as Playwright would
 * have done at once.
 */
export class PageDialogs {
  private readonly held = new Map<string, HeldDialog>();
  private readonly watchers = new Map<string, Set<() => void>>();

  constructor(
    private readonly timers: DialogTimers = SYSTEM_TIMERS,
    private readonly holdMs: number = BROWSER_DIALOG_HOLD_MS,
  ) {}

  hold(key: string, dialog: HeldDialogPort): void {
    const older = this.held.get(key);
    if (older) {
      this.timers.clear(older.timer);
      void older.dialog.dismiss().catch(() => undefined);
    }
    const type = BrowserDialogTypeSchema.safeParse(dialog.type());
    const info: BrowserDialogInfo = {
      type: type.success ? type.data : 'alert',
      message: dialog.message().slice(0, BROWSER_DIALOG_MESSAGE_MAX_CHARS),
    };
    const timer = this.timers.set(() => {
      void this.answer(key, 'dismiss').catch(() => undefined);
    }, this.holdMs);
    this.held.set(key, { dialog, info, timer });
    for (const watcher of [...(this.watchers.get(key) ?? [])]) watcher();
  }

  pending(key: string): BrowserDialogInfo | undefined {
    return this.held.get(key)?.info;
  }

  async answer(key: string, action: BrowserDialogAction, promptText?: string): Promise<BrowserDialogInfo> {
    const held = this.held.get(key);
    if (held === undefined) throw new Error('no dialog is open on this page');
    this.held.delete(key);
    this.timers.clear(held.timer);
    if (action === 'accept') await held.dialog.accept(promptText);
    else await held.dialog.dismiss();
    return held.info;
  }

  /** Settles when a dialog is open on the page — at once, if one already is. */
  opened(key: string): { readonly promise: Promise<void>; readonly cancel: () => void } {
    if (this.held.has(key)) return { promise: Promise.resolve(), cancel: () => undefined };
    const watchers = this.watchers.get(key) ?? new Set<() => void>();
    this.watchers.set(key, watchers);
    let watcher: () => void = () => undefined;
    const promise = new Promise<void>(resolve => {
      watcher = () => {
        watchers.delete(watcher);
        resolve();
      };
      watchers.add(watcher);
    });
    return {
      promise,
      cancel: () => {
        watchers.delete(watcher);
        if (watchers.size === 0) this.watchers.delete(key);
      },
    };
  }

  /** The page closed: forget its dialog without answering it. */
  drop(key: string): void {
    const held = this.held.get(key);
    if (held) this.timers.clear(held.timer);
    this.held.delete(key);
    this.watchers.delete(key);
  }
}

const CONSOLE_RANK: Readonly<Record<BrowserConsoleLevel, number>> = {
  error: 0,
  warning: 1,
  info: 2,
  log: 3,
  debug: 4,
};

/** A browser console type as one of the five levels an agent filters by. */
export function consoleLevelOf(type: string): BrowserConsoleLevel {
  if (type === 'assert') return 'error';
  return (BROWSER_CONSOLE_LEVELS as readonly string[]).includes(type) ? (type as BrowserConsoleLevel) : 'log';
}

interface ConsoleEntry {
  readonly seq: number;
  readonly level: BrowserConsoleLevel;
  readonly text: string;
  readonly where: string;
}

export interface ConsoleQuery {
  readonly level?: BrowserConsoleLevel | undefined;
  readonly since?: number | undefined;
  readonly limit?: number | undefined;
}

/** The last {@link BROWSER_CONSOLE_BUFFER} things a page logged. */
export class ConsoleLog {
  private readonly entries: ConsoleEntry[] = [];
  private seq = 0;

  add(type: string, text: string, location?: { readonly url?: string; readonly lineNumber?: number }): void {
    this.seq += 1;
    const url = location?.url ? withoutUserInfo(location.url) : '';
    this.entries.push({
      seq: this.seq,
      level: consoleLevelOf(type),
      text: text.slice(0, BROWSER_CONSOLE_MESSAGE_MAX_CHARS),
      where: url === '' ? '' : ` (${url}${location?.lineNumber === undefined ? '' : `:${location.lineNumber + 1}`})`,
    });
    if (this.entries.length > BROWSER_CONSOLE_BUFFER) this.entries.shift();
  }

  read(query: ConsoleQuery = {}): string {
    const worst = query.level === undefined ? CONSOLE_RANK.debug : CONSOLE_RANK[query.level];
    const wanted = this.entries
      .filter(entry => entry.seq > (query.since ?? 0) && CONSOLE_RANK[entry.level] <= worst)
      .slice(-(query.limit ?? BROWSER_CONSOLE_DEFAULT_LIMIT));
    if (wanted.length === 0) return `no console messages (last entry #${this.seq})`;
    return [
      ...wanted.map(entry => `#${entry.seq} [${entry.level}] ${entry.text}${entry.where}`),
      `last entry #${this.seq}: ask with since: ${this.seq} for what comes after`,
    ].join('\n');
  }
}

/** A URL without the user name and password it may carry. */
export function withoutUserInfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return url;
  }
}

const ALWAYS_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
]);
const STRIPPED_HEADER_FRAGMENTS = ['token', 'api-key', 'apikey', 'secret'] as const;

/** Whether a header may never be shown to an agent: a credential by name. */
export function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return ALWAYS_STRIPPED_HEADERS.has(lower) || STRIPPED_HEADER_FRAGMENTS.some(fragment => lower.includes(fragment));
}

export interface LoggedRequestPort {
  method(): string;
  url(): string;
  resourceType(): string;
  sizes(): Promise<{ readonly responseBodySize: number }>;
}

export interface LoggedResponsePort {
  status(): number;
  headers(): Readonly<Record<string, string>>;
  body(): Promise<Uint8Array>;
}

interface NetworkEntry {
  readonly seq: number;
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly type: BrowserResourceType;
  readonly startedAt: number;
  status?: number;
  size?: number;
  ms?: number;
  failure?: string;
  response?: LoggedResponsePort;
}

export interface NetworkQuery {
  readonly filter?: string | undefined;
  readonly types?: readonly BrowserResourceType[] | undefined;
}

const TEXT_BODY = /(?:^text\/|json|xml|javascript|ecmascript|html|svg|x-www-form-urlencoded)/iu;

/** The last {@link BROWSER_NETWORK_BUFFER} requests a page made: what was asked, what came back, how long it took. */
export class NetworkLog {
  private readonly entries = new Map<string, NetworkEntry>();
  private readonly byRequest = new WeakMap<object, NetworkEntry>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  started(request: LoggedRequestPort): void {
    this.seq += 1;
    const entry: NetworkEntry = {
      seq: this.seq,
      id: `r${this.seq}`,
      method: request.method(),
      url: withoutUserInfo(request.url()),
      type: resourceTypeOf(request.resourceType()),
      startedAt: this.now(),
    };
    this.entries.set(entry.id, entry);
    this.byRequest.set(request, entry);
    if (this.entries.size > BROWSER_NETWORK_BUFFER) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  responded(request: object, response: LoggedResponsePort): void {
    const entry = this.byRequest.get(request);
    if (entry === undefined) return;
    entry.status = response.status();
    entry.response = response;
  }

  async finished(request: LoggedRequestPort): Promise<void> {
    const entry = this.byRequest.get(request);
    if (entry === undefined) return;
    entry.ms = this.now() - entry.startedAt;
    const sizes = await request.sizes().catch(() => undefined);
    if (sizes !== undefined && sizes.responseBodySize >= 0) entry.size = sizes.responseBodySize;
  }

  failed(request: object, errorText: string): void {
    const entry = this.byRequest.get(request);
    if (entry === undefined) return;
    entry.ms = this.now() - entry.startedAt;
    entry.failure = errorText.slice(0, 120) || 'failed';
  }

  list(query: NetworkQuery = {}): string {
    const wanted = [...this.entries.values()]
      .filter(entry => query.filter === undefined || entry.url.includes(query.filter))
      .filter(entry => query.types === undefined || query.types.includes(entry.type))
      .slice(-BROWSER_NETWORK_LIST_LIMIT);
    if (wanted.length === 0) return 'no requests recorded';
    return wanted.map(describeRequest).join('\n');
  }

  async get(id: string): Promise<string> {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error(`${id} is not in this page's request log (it may have been dropped)`);
    const lines = [describeRequest(entry)];
    const response = entry.response;
    if (response === undefined) {
      lines.push(entry.failure === undefined ? 'no response yet' : `no response: ${entry.failure}`);
      return lines.join('\n');
    }
    const headers = Object.entries(response.headers()).filter(([name]) => !isCredentialHeader(name));
    if (headers.length > 0) lines.push('response headers:', ...headers.map(([name, value]) => `  ${name}: ${value}`));
    const contentType = Object.entries(response.headers()).find(([name]) => name.toLowerCase() === 'content-type');
    if (contentType !== undefined && !TEXT_BODY.test(contentType[1])) {
      lines.push(`(body not shown: ${contentType[1].split(';')[0] ?? 'binary'})`);
      return lines.join('\n');
    }
    const body = await response.body().catch(() => undefined);
    if (body === undefined) lines.push('(the response body is no longer available)');
    else {
      const clipped = body.byteLength > BROWSER_NETWORK_BODY_MAX_BYTES;
      lines.push(
        '',
        new TextDecoder().decode(body.subarray(0, BROWSER_NETWORK_BODY_MAX_BYTES)),
        ...(clipped ? [`(body clipped to ${BROWSER_NETWORK_BODY_MAX_BYTES} bytes of ${body.byteLength})`] : []),
      );
    }
    return lines.join('\n');
  }
}

function resourceTypeOf(type: string): BrowserResourceType {
  const known = [
    'document',
    'stylesheet',
    'image',
    'media',
    'font',
    'script',
    'texttrack',
    'xhr',
    'fetch',
    'eventsource',
    'websocket',
    'manifest',
  ] as const;
  return (known as readonly string[]).includes(type) ? (type as BrowserResourceType) : 'other';
}

function describeRequest(entry: NetworkEntry): string {
  const outcome = entry.failure !== undefined ? `failed (${entry.failure})` : String(entry.status ?? 'pending');
  return [
    entry.id,
    entry.method,
    outcome,
    entry.type,
    entry.size === undefined ? '-' : formatBytes(entry.size),
    entry.ms === undefined ? '-' : `${entry.ms}ms`,
    entry.url,
  ].join(' ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

/** What a wait needs of a page. */
export interface WaitableLocator {
  first(): WaitableLocator;
  waitFor(options: {
    readonly state: 'visible' | 'hidden' | 'attached' | 'detached';
    readonly timeout: number;
  }): Promise<void>;
  innerText(options: { readonly timeout: number }): Promise<string>;
}

export interface WaitablePage {
  url(): string;
  locator(selector: string): WaitableLocator;
  waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    options: { readonly timeout: number },
  ): Promise<void>;
}

export interface Pause {
  (ms: number): Promise<void>;
}

const POLL_MS = 100;
const pause: Pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const isTimeout = (error: unknown): boolean => error instanceof Error && error.name === 'TimeoutError';

/**
 * Whether a condition held within `timeoutMs`. A timeout is an answer (`false`), never an error; a bad
 * selector or a closed page is still an error.
 */
export async function waitForCondition(
  page: WaitablePage,
  condition: BrowserWaitCondition,
  timeoutMs: number,
  sleep: Pause = pause,
): Promise<boolean> {
  try {
    if (condition.kind === 'element') {
      await page
        .locator(browserSelectorOf(condition.target as BrowserElementTarget))
        .first()
        .waitFor({ state: condition.state, timeout: timeoutMs });
      return true;
    }
    if (condition.kind === 'load') {
      await page.waitForLoadState(condition.state, { timeout: timeoutMs });
      return true;
    }
    if (condition.kind === 'time') {
      await sleep(Math.min(condition.ms, timeoutMs));
      return true;
    }
    return await pollFor(page, condition, timeoutMs, sleep);
  } catch (error) {
    if (isTimeout(error)) return false;
    throw error;
  }
}

async function pollFor(
  page: WaitablePage,
  condition: Extract<BrowserWaitCondition, { kind: 'text' | 'textGone' | 'url' }>,
  timeoutMs: number,
  sleep: Pause,
): Promise<boolean> {
  let waited = 0;
  for (;;) {
    if (condition.kind === 'url') {
      if (page.url().includes(condition.url)) return true;
    } else {
      const shown = await page
        .locator('body')
        .first()
        .innerText({ timeout: Math.max(POLL_MS, timeoutMs - waited) })
        .catch(error => {
          if (isTimeout(error)) return undefined;
          throw error;
        });
      if (shown !== undefined && shown.includes(condition.text) === (condition.kind === 'text')) return true;
    }
    if (waited >= timeoutMs) return false;
    const step = Math.min(POLL_MS, timeoutMs - waited);
    await sleep(step);
    waited += step;
  }
}

/** The Chrome DevTools session an emulation is sent through. */
export interface EmulationSession {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface EmulationTargets {
  readonly session: EmulationSession;
  /** The worker's own resize, so a screencast keeps up with the new size. */
  setViewport(viewport: { readonly width: number; readonly height: number }): Promise<void>;
  /** The page's address, to scope a permission to its origin. */
  url(): string;
  grantPermissions(permissions: readonly string[], origin: string): Promise<void>;
  clearPermissions(): Promise<void>;
}

type Media = NonNullable<BrowserEmulation['media']>;

export const DEFAULT_EMULATED_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * One page's emulation. Media features are remembered here because Chrome replaces the whole set on each
 * call; the network conditions given last are the conditions in force.
 *
 * NEVER the user agent and never a client-hint header: a site would take the agent for somebody else.
 */
export class PageEmulation {
  private media: Media = {};

  async apply(targets: EmulationTargets, emulation: BrowserEmulation): Promise<string> {
    const done: string[] = [];
    const { session } = targets;
    if (emulation.reset === true) {
      this.media = {};
      await this.sendMedia(session);
      await session.send('Emulation.setGeolocationOverride', {});
      await session.send('Emulation.setLocaleOverride', {});
      await session.send('Emulation.setTimezoneOverride', { timezoneId: '' });
      await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await session.send('Network.enable');
      await session.send('Network.emulateNetworkConditions', networkConditions(undefined));
      await targets.clearPermissions();
      await targets.setViewport(DEFAULT_EMULATED_VIEWPORT);
      done.push('reset to the defaults');
    }
    if (emulation.viewport !== undefined) {
      await targets.setViewport(emulation.viewport);
      done.push(`viewport ${emulation.viewport.width}x${emulation.viewport.height}`);
    }
    if (emulation.media !== undefined) {
      this.media = { ...this.media, ...emulation.media };
      await this.sendMedia(session);
      done.push(
        `media ${Object.entries(emulation.media)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(' ')}`,
      );
    }
    if (emulation.geolocation !== undefined) {
      const { latitude, longitude, accuracy } = emulation.geolocation;
      await session.send('Emulation.setGeolocationOverride', { latitude, longitude, accuracy: accuracy ?? 100 });
      done.push(`geolocation ${latitude},${longitude}`);
    }
    if (emulation.locale !== undefined) {
      await session.send('Emulation.setLocaleOverride', { locale: emulation.locale });
      done.push(`locale ${emulation.locale}`);
    }
    if (emulation.timezone !== undefined) {
      await session.send('Emulation.setTimezoneOverride', { timezoneId: emulation.timezone });
      done.push(`timezone ${emulation.timezone}`);
    }
    if (emulation.cpuThrottle !== undefined) {
      await session.send('Emulation.setCPUThrottlingRate', { rate: emulation.cpuThrottle });
      done.push(`cpu ${emulation.cpuThrottle}x slower`);
    }
    if (emulation.network !== undefined) {
      await session.send('Network.enable');
      await session.send('Network.emulateNetworkConditions', networkConditions(emulation.network));
      done.push(
        `network ${emulation.network.offline === true ? 'offline' : 'online'}${
          emulation.network.latency === undefined ? '' : ` +${emulation.network.latency}ms`
        }${emulation.network.throughput === undefined ? '' : ` ${emulation.network.throughput}kbit/s`}`,
      );
    }
    if (emulation.permissions !== undefined) {
      const origin = originOf(targets.url());
      await targets.grantPermissions(emulation.permissions, origin);
      done.push(`permissions ${emulation.permissions.join(',')} for ${origin}`);
    }
    return `Emulating: ${done.join('; ')}`;
  }

  private async sendMedia(session: EmulationSession): Promise<void> {
    const features = [
      ['prefers-color-scheme', this.media.colorScheme],
      ['prefers-reduced-motion', this.media.reducedMotion],
      ['forced-colors', this.media.forcedColors],
      ['prefers-contrast', this.media.contrast],
    ].flatMap(([name, value]) => (value === undefined ? [] : [{ name, value }]));
    await session.send('Emulation.setEmulatedMedia', { media: this.media.print === true ? 'print' : '', features });
  }
}

function networkConditions(
  network: BrowserEmulation['network'],
): Readonly<{ offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> {
  const bytesPerSecond = network?.throughput === undefined ? -1 : Math.round((network.throughput * 1_000) / 8);
  return {
    offline: network?.offline === true,
    latency: network?.latency ?? 0,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: bytesPerSecond,
  };
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  } catch {}
  throw new Error('permissions are granted to a website: open a page on it first');
}

/** Everything one page's lifecycle request may touch. */
export interface LifecycleScope {
  readonly pageKey: string;
  readonly page: WaitablePage;
  readonly dialogs: PageDialogs;
  readonly messages: ConsoleLog;
  readonly network: NetworkLog;
  readonly emulation: PageEmulation;
  readonly targets: EmulationTargets;
  readonly sleep?: Pause;
}

/** Runs one lifecycle request against one page. */
export async function runLifecycleRequest(
  scope: LifecycleScope,
  request: BrowserPageLifecycleRequest,
): Promise<BrowserPageLifecycleReply> {
  switch (request.op) {
    case 'dialog': {
      const answered = await scope.dialogs.answer(scope.pageKey, request.action, request.promptText);
      return {
        text: `${request.action === 'accept' ? 'accepted' : 'dismissed'} the ${answered.type} dialog: ${answered.message}`,
        dialogType: answered.type,
      };
    }
    case 'wait': {
      const matched = await waitForCondition(scope.page, request.condition, request.timeoutMs, scope.sleep);
      return { text: matched ? 'condition met' : 'condition not met yet', matched };
    }
    case 'console':
      return { text: scope.messages.read(request) };
    case 'network':
      return {
        text:
          request.action === 'get'
            ? await scope.network.get(request.id ?? '')
            : scope.network.list({ filter: request.filter, types: request.types }),
      };
    case 'emulate':
      return { text: await scope.emulation.apply(scope.targets, request.emulation) };
  }
}
