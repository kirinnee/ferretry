import { KERNEL_REFUSALS, PluginsChanged, parseRouteKey } from '@ferretry/kernel/contract';
import type { EventDef } from '@ferretry/kernel/contract';
import {
  allowedCallHeaders,
  type PluginClient,
  type PluginConditionalAnswer,
  type PluginConditionalInit,
} from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { PairedDaemon } from '../daemons/daemon-list.ts';
import { type PasskeyHandler, type PasskeyNeed, type PromptOrigin, requestOrigin } from '../passkey/passkey.ts';
import { backoffKey, StepUpBackoff } from './step-up-backoff.ts';
import type { SurfaceEntry } from '../surfaces/registry.ts';
import { untilAborted } from './machine-deadline.ts';
import { DEVICE_NOT_ACCEPTED_SENTENCE } from './sentences.ts';
import {
  eventOwner,
  type Inventory,
  inventoryFromAnswer,
  type Standing,
  standings,
  unreadableBecause,
} from './inventory.ts';
import {
  CARRIER_OUTAGE_CODE,
  DaemonCallError,
  type DaemonTransport,
  DEVICE_REFUSED_CODE,
  carrierFateOf,
  isCarrierGone,
  isDeviceRefusal,
  type SocketListeners,
  type TransportAnswer,
  type TransportSocket,
} from './transport.ts';

/**
 * THE GENERATED PER-DAEMON CLIENT (§9.6). The app talks to a daemon only through this, so the hash guard is here and
 * not at the view: it also blocks calls, subscriptions and sockets.
 *
 * 1. **The safe bootstrap read.** After the session principal exists, the first and only call is `GET /v1/plugins`;
 *    until it answers nothing else is sent and no plugin code starts (calls made meanwhile WAIT, unsent). Then
 *    `GET /v1/health` tells which side is newer, for the sentence.
 * 2. **Before every route call, event subscription and socket open** the owning package's entry is checked: present,
 *    `on`, and effective hash equal to the compiled one. Anything else fails `plugin_paused` without sending, the
 *    subscription is never made, and no decoder for that package is installed: an event for a package the client did
 *    not subscribe to, or one that is blocked, is dropped unparsed.
 * 3. **Re-checked on change.** On reconnect the inventory is re-read before anything resumes; on
 *    `kernel.plugins-changed` it is re-read, the sockets of every package now blocked are closed, and subscriptions of
 *    packages now allowed resume (their listeners simply start hearing again).
 * 4. **A passkey refusal is a pause, not a failure** (G105). A call the daemon refused for want of an unlock or a
 *    step-up is shown to Access's passkey handler (`passkey/passkey.ts`); once the person has confirmed it is sent
 *    again ONCE, through the same guard. Every plugin's call takes this path, so none of them asks for itself.
 */

const HealthEnvelopeSchema = z.object({ protocol: z.number().int(), version: z.string().max(64) });

export const INVENTORY_ROUTE = 'GET /v1/plugins';
export const HEALTH_ROUTE = 'GET /v1/health';
/** Gate's grants read (`GET /v1/grants`): authenticated, not capability-gated, behind the unlock. */
const GRANTS_PATH = '/v1/grants';
/** The package that owns the grants read: the shell's own read admits as it, caller and owner alike. */
const GATE_PACKAGE = 'gate';

/** Said when a call died on the carrier, before any answer. */
const CARRIER_OUTAGE_SENTENCE = 'The connection to this machine was lost before it answered.';

/**
 * What this client tells the shell's grants cache (shell contract S1) about the answers it sees, so a stale control
 * heals: a confirm the person gave, a machine that wants its unlock, a capability refusal. Each answer-borne signal
 * carries the GENERATION its request was sent under; a confirm bumps the generation, so an answer to a request sent
 * before the unlock can be told apart and ignored.
 */
export type AuthoritySignal =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'locked'; readonly generation: number }
  | { readonly kind: 'refused'; readonly generation: number };

/** The shell's own grants read: the answer (none when nothing came back), the handler's reading, its generation. */
export interface GrantsRead {
  readonly generation: number;
  readonly answer: TransportAnswer | undefined;
  readonly need: PasskeyNeed | undefined;
}

/** A capability refusal from Gate's admission (`grant_not_granted`, `grant_step_up_required`, …). */
const isCapabilityRefusal = (answer: TransportAnswer): boolean => {
  if (answer.status !== 403 || typeof answer.body !== 'object' || answer.body === null) return false;
  const code = (answer.body as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('grant_');
};

export interface DaemonClientOptions {
  readonly transport: DaemonTransport;
  readonly surfaces: readonly SurfaceEntry[];
  /**
   * Waits (ms) between the reads of the plugin list that follow a failed one, the last repeating. A failed read leaves
   * the whole machine on "could not read what this daemon offers", so it is asked again until it answers (a carrier
   * that dropped, a daemon still starting) instead of staying that way until the app is reopened. Default: 1 s doubling
   * to 30 s. An empty list reads once.
   */
  readonly rereadAfterMs?: readonly number[];
  /**
   * How long (ms) each bootstrap read (the plugin list, then the health read) may wait for its answer. A carrier that is
   * healthy but never answers one would otherwise leave every call and socket waiting on the list for ever. On timeout the
   * plugin list is told as unreadable (and asked again by the same re-read plan as any failed read) and the health read as
   * absent. Default 15 s.
   */
  readonly bootstrapDeadlineMs?: number;
  /**
   * The daemon this client reaches and Access's passkey handler (`passkey/passkey.ts`): a refusal for want of an
   * unlock or a step-up is shown to it, and the call is sent again ONCE when the person confirmed. Absent, nothing can
   * ask and every refusal is returned as it came.
   */
  readonly passkey?: { readonly daemon: PairedDaemon; readonly handler: PasskeyHandler };
  /**
   * The plugin list this device remembered from the last LIVE read of this machine (`shell/shape-memory.ts`). It is only
   * what to DRAW until the live read answers: no route, tool, subscription or socket is admitted on it, and the live
   * answer replaces it whatever it says. Absent (or unusable by this build), the client starts unread as it always did.
   */
  readonly remembered?: Extract<Inventory, { kind: 'read' }>;
  /** Told every LIVE plugin list, whatever it says, so the device can remember a good one and forget a bad one. */
  readonly onRead?: (inventory: Inventory) => void;
  /** Told what the daemon calls its machine, every time the plugin list is read: a rename reaches this device by it. */
  readonly learnName?: (name: string) => void;
  /** The clock a background read's step-up backoff runs on ({@link StepUpBackoff}); the wall clock when absent. */
  readonly now?: () => number;
  /**
   * Whether a person is PRESSING something on this page right now: the browser's own transient user activation
   * (`navigator.userActivation.isActive`, a few seconds after a click or a key) when absent; the shell narrows it to "and
   * the page did not just change" (`ShellRuntime`). A read sent while it holds is the person's own — a Retry, the
   * machine they chose — and asks for its passkey at once like a press; a read sent without it — a page opening, a
   * poll, an effect re-run by a re-render — never opens the prompt (A555 r7).
   */
  readonly personActing?: () => boolean;
}

/** The browser's transient user activation; `false` where there is none to read (a test, a worker). */
export const browserActivation = (): boolean =>
  (globalThis.navigator as { readonly userActivation?: { readonly isActive?: boolean } } | undefined)?.userActivation
    ?.isActive === true;

/**
 * Who a package client's calls are on behalf of, for the passkey (S2): `ordinary` asks as the request's method says
 * (a read waits for its machine to be on screen, and asks for a step-up only while a person is acting; a press asks at
 * once); `background` makes EVERY call a background read, whatever its method, so a background view never raises a
 * step-up prompt.
 */
export type ClientOrigin = 'ordinary' | 'background';

/** The shell's widening of the leaf's `PluginClient`: the same guard over sockets. */
export interface ShellPluginClient extends PluginClient {
  socket(
    key: string,
    params: Readonly<Record<string, string>>,
    listeners: SocketListeners,
    query?: Readonly<Record<string, string>>,
  ): TransportSocket;
}

interface Subscription {
  readonly def: EventDef;
  readonly listeners: Set<(payload: unknown) => void>;
}

interface OpenSocket {
  /** The caller and the owner: both must stay allowed. */
  readonly ids: readonly string[];
  readonly socket: TransportSocket;
  readonly listeners: SocketListeners;
}

/** `/v1/board/:id` + `{ id: 'F 1' }` → `/v1/board/F%201`. A missing parameter, `.`, `..` or one holding a `/` is refused. */
export function fillPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new TypeError(`route ${template} needs the parameter "${name}"`);
    if (value === '.' || value === '..' || value.includes('/'))
      throw new TypeError(`route ${template}: the parameter "${name}" cannot be "." or ".." or hold a "/"`);
    return encodeURIComponent(value);
  });
}

function paused(owner: string, standing: Standing): DaemonCallError {
  const reason = standing.state === 'blocked' ? standing.reason : 'allowed';
  return new DaemonCallError(0, KERNEL_REFUSALS.pluginPaused.code, `${owner} is paused on this daemon (${reason}).`);
}

function stopped(): DaemonCallError {
  return new DaemonCallError(0, KERNEL_REFUSALS.pluginPaused.code, 'This connection was closed.');
}

function refusal(answer: TransportAnswer): DaemonCallError {
  const body = typeof answer.body === 'object' && answer.body !== null ? (answer.body as Record<string, unknown>) : {};
  const code = typeof body.code === 'string' ? body.code : `http_${answer.status}`;
  const message = typeof body.error === 'string' ? body.error : `The daemon answered ${answer.status}.`;
  return new DaemonCallError(answer.status, code, message, answer.body);
}

/** 1 s doubling to 30 s: a read that failed is asked again until it answers. */
const DEFAULT_REREAD_AFTER_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const DEFAULT_BOOTSTRAP_DEADLINE_MS = 15_000;

/** `work`, or a rejection once `ms` has passed without it: the bootstrap reads never wait for ever. */
async function within<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the daemon did not answer within ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

export class DaemonClient {
  readonly #transport: DaemonTransport;
  readonly #surfaces: readonly SurfaceEntry[];
  readonly #passkey: DaemonClientOptions['passkey'];
  readonly #learnName: DaemonClientOptions['learnName'];
  /** Which package declares each route and socket key, across every compiled manifest. */
  readonly #routeOwner = new Map<string, string>();
  readonly #socketOwner = new Map<string, string>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #sockets = new Set<OpenSocket>();
  readonly #changeListeners = new Set<() => void>();
  #inventory: Inventory | undefined;
  /** The inventory above is the one this device REMEMBERED, to draw from; no call is admitted until a live read replaces it. */
  #provisional = false;
  readonly #onRead: DaemonClientOptions['onRead'];
  #standings: ReadonlyMap<string, Standing>;
  #daemonVersion: string | undefined;
  #ready: Promise<void>;
  #settle: () => void = () => {};
  #reading: Promise<void> | undefined;
  #stopEvents: (() => void) | undefined;
  #feedLive = false;
  readonly #liveListeners = new Set<(live: boolean) => void>();
  #stopReconnect: (() => void) | undefined;
  #stopped = false;
  /** Bumped by every passkey confirm the shell hears of (S1, R3 m2). */
  #generation = 0;
  readonly #authorityListeners = new Set<(signal: AuthoritySignal) => void>();
  readonly #refusedListeners = new Set<() => void>();
  #refused = false;
  readonly #rereadAfterMs: readonly number[];
  readonly #bootstrapDeadlineMs: number;
  /** Sockets handed out before the live list answered: each is told once if this client stops first. */
  readonly #waitingSockets = new Set<() => void>();
  /** Failed reads in a row, and the pending re-read's timer; both reset by an answered read. */
  #failedReads = 0;
  #rereadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Background reads refused for a step-up, answered with that refusal for a while rather than sent again. */
  readonly #backoff: StepUpBackoff;
  /** The daemon's machine-wide unlock refusal; other passive routes wait on it without sending. */
  #lockedAnswer: TransportAnswer | undefined;
  readonly #personActing: () => boolean;
  /** The passkey a read nobody caused was last refused for, until a confirm: what the shell offers a press for. */
  #unasked: PasskeyNeed | undefined;
  readonly #unaskedListeners = new Set<() => void>();

  constructor(options: DaemonClientOptions) {
    this.#backoff = new StepUpBackoff(options.now);
    this.#personActing = options.personActing ?? browserActivation;
    this.#transport = options.transport;
    this.#surfaces = options.surfaces;
    this.#rereadAfterMs = options.rereadAfterMs ?? DEFAULT_REREAD_AFTER_MS;
    this.#bootstrapDeadlineMs = options.bootstrapDeadlineMs ?? DEFAULT_BOOTSTRAP_DEADLINE_MS;
    this.#passkey = options.passkey;
    this.#learnName = options.learnName;
    this.#onRead = options.onRead;
    for (const entry of options.surfaces) {
      for (const route of entry.manifest.actions?.routes ?? []) this.#routeOwner.set(route.key, entry.id);
      for (const socket of entry.manifest.actions?.sockets ?? []) this.#socketOwner.set(socket.key, entry.id);
    }
    this.#standings = standings(undefined, this.#surfaces);
    // A remembered list that this build can still use whole (no contract moved, nothing needs an update) is drawn from at
    // once; anything else is not used (it would flash "needs an update" and then go).
    const remembered = options.remembered;
    if (remembered !== undefined) {
      const drawn = standings(remembered, this.#surfaces);
      const usable = [...drawn.values()].every(
        s => s.state === 'allowed' || s.reason === 'off' || s.reason === 'missing',
      );
      if (usable) {
        this.#inventory = remembered;
        this.#standings = drawn;
        this.#provisional = true;
      }
    }
    this.#ready = this.#pending();
  }

  /** The bootstrap read; resolves once the inventory answered (whatever it said). */
  start(): Promise<void> {
    this.#stopReconnect ??= this.#transport.onReconnect(() => void this.refresh());
    this.#subscribeInternal(PluginsChanged, () => void this.refresh());
    return this.refresh();
  }

  stop(): void {
    this.#stopped = true;
    // Whatever waits for the inventory (an admission, a deferred socket) is woken to find the client stopped.
    this.#settle();
    // A socket still waiting for the live list is told once that it will never open.
    for (const abandon of [...this.#waitingSockets]) abandon();
    this.#waitingSockets.clear();
    this.#stopEvents?.();
    this.#stopEvents = undefined;
    this.#setFeedLive(false);
    this.#stopReconnect?.();
    if (this.#rereadTimer !== undefined) clearTimeout(this.#rereadTimer);
    this.#rereadTimer = undefined;
    for (const open of this.#sockets) open.socket.close();
    this.#sockets.clear();
  }

  /** Re-reads the inventory. Calls made meanwhile wait; nothing else is sent until it answers. */
  refresh(): Promise<void> {
    if (this.#reading !== undefined) return this.#reading;
    if (this.#inventory !== undefined && !this.#provisional) {
      this.#inventory = undefined;
      this.#standings = standings(undefined, this.#surfaces);
      this.#ready = this.#pending();
    }
    this.#reading = this.#read().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  get inventory(): Inventory | undefined {
    return this.#inventory;
  }

  get daemonVersion(): string | undefined {
    return this.#daemonVersion;
  }

  standing(id: string): Standing {
    return this.#standings.get(id) ?? { state: 'blocked', reason: 'missing' };
  }

  /** The generation requests are sent under now; bumped by every confirm (S1). */
  get generation(): number {
    return this.#generation;
  }

  /** Whether the daemon's event feed is live right now (the view place's `online`). */
  get feedLive(): boolean {
    return this.#feedLive;
  }

  /** Fires on every change of {@link feedLive}. */
  onFeedLive(listener: (live: boolean) => void): () => void {
    this.#liveListeners.add(listener);
    return () => this.#liveListeners.delete(listener);
  }

  /**
   * The passkey this machine refused a read NOBODY CAUSED for (A555 r7), until a confirm: the unlock before a step-up.
   * No prompt opened for it, so the shell offers one press for it instead (`shell/passkey-bar.tsx`); a page is never
   * left with a refusal and no way to answer it.
   */
  unaskedNeed(): PasskeyNeed | undefined {
    return this.#unasked;
  }

  /** Fires when {@link unaskedNeed} changes. */
  onUnasked(listener: () => void): () => void {
    this.#unaskedListeners.add(listener);
    return () => this.#unaskedListeners.delete(listener);
  }

  #setUnasked(need: PasskeyNeed | undefined): void {
    // The unlock comes first: while it is wanted nothing else can be read, so a step-up never replaces it.
    if (need !== undefined && this.#unasked?.kind === 'unlock') return;
    if (need === this.#unasked || (need?.kind === 'step-up' && this.#unasked?.kind === 'step-up')) return;
    this.#unasked = need;
    for (const listener of [...this.#unaskedListeners]) listener();
  }

  /** Fires on every {@link AuthoritySignal}: the grants cache's re-read triggers. */
  onAuthority(listener: (signal: AuthoritySignal) => void): () => void {
    this.#authorityListeners.add(listener);
    return () => this.#authorityListeners.delete(listener);
  }

  /**
   * A confirm the person gave for this machine OUTSIDE this client's own pause (the shell's explicit unlock, a
   * press's asked step-up): the generation moves on, and the grants are re-read.
   */
  noteConfirmed(): void {
    this.#backoff.clear();
    this.#lockedAnswer = undefined;
    this.#setUnasked(undefined);
    this.#generation += 1;
    this.#signal({ kind: 'confirmed' });
    // A locked machine refused its live feed until now: open it again, so the machine is live, not merely reachable.
    this.#ensureEvents();
  }

  /**
   * THE SHELL'S OWN GRANTS READ (S1, R3 m3), NEVER PAUSED. A method of this class only — `forPackage` hands no plugin
   * a way to it — so no plugin can send a request that skips the passkey's pause. It admits as Gate, caller and owner
   * both, so a paused plugin never hides it; a `401 unlock_required` comes back at once with the handler's reading of
   * it (the machine is `locked`), never held for a prompt. It lets nothing through: it only reads.
   */
  async readGrants(_options: { readonly noPause: true }): Promise<GrantsRead> {
    await this.#admit(GATE_PACKAGE, GATE_PACKAGE);
    const generation = this.#generation;
    let answer: TransportAnswer | undefined;
    try {
      answer = await this.#transport.request({ method: 'GET', path: GRANTS_PATH });
    } catch {
      answer = undefined;
    }
    if (generation === this.#generation && answer !== undefined) {
      if (this.#need(answer)?.kind === 'unlock') this.#lockedAnswer = answer;
      else if (answer.status < 400 && this.#lockedAnswer !== undefined) {
        this.#lockedAnswer = undefined;
        this.#backoff.clear();
        if (this.#unasked?.kind === 'unlock') this.#setUnasked(undefined);
      }
    }
    return { generation, answer, need: answer === undefined ? undefined : this.#need(answer) };
  }

  /**
   * Fires ONCE, when a session ended with the device-refused close (`4403`) on this machine (S12). That close is a
   * cleartext word a relay can forge (`docs/relay-protocol.md`), so it is NOT proof the pairing is gone: the shell
   * stops dialling this machine for this page and says so, and deletes nothing. Only the person's own removal unpairs.
   */
  onRefused(listener: () => void): () => void {
    this.#refusedListeners.add(listener);
    return () => this.#refusedListeners.delete(listener);
  }

  /** Fires after every inventory change; the shell re-renders from {@link standing}. */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /**
   * The client one package's half talks through. Every call is guarded by the OWNER of the route it names. With
   * `origin: 'background'` every call it sends is a background read for the passkey ({@link ClientOrigin}).
   */
  forPackage(caller: string, options: { readonly origin?: ClientOrigin } = {}): ShellPluginClient {
    const background = options.origin === 'background';
    return {
      call: (route, init) => this.#call(caller, route, init, background),
      callWithStatus: (route, init) => this.#callWithStatus(caller, route, init, background),
      conditional: (route, params, init) => this.#conditional(caller, route, params, init, background),
      subscribe: (event, listener) => this.#subscribe(caller, event, listener),
      socket: (key, params, listeners, query) => this.#socket(caller, key, params, listeners, query),
      feed: {
        isLive: () => this.#feedLive,
        subscribeLive: listener => {
          this.#liveListeners.add(listener);
          return () => this.#liveListeners.delete(listener);
        },
      },
    };
  }

  #setFeedLive(live: boolean): void {
    if (this.#feedLive === live) return;
    this.#feedLive = live;
    for (const listener of [...this.#liveListeners]) listener(live);
  }

  // ─── internals ──────────────────────────────────────────────────────────────────────────────────────────────────

  #pending(): Promise<void> {
    return new Promise<void>(resolve => {
      this.#settle = resolve;
    });
  }

  async #read(): Promise<void> {
    let inventory: Inventory;
    try {
      const answer = await within(
        signal => this.#transport.request({ method: 'GET', path: parseRouteKey(INVENTORY_ROUTE).path, signal }),
        this.#bootstrapDeadlineMs,
      );
      inventory = inventoryFromAnswer(answer);
    } catch (error) {
      if (isDeviceRefusal(error)) this.#refuse();
      inventory = unreadableBecause(error);
    }
    try {
      const health = await within(
        signal => this.#transport.request({ method: 'GET', path: parseRouteKey(HEALTH_ROUTE).path, signal }),
        this.#bootstrapDeadlineMs,
      );
      const parsed = HealthEnvelopeSchema.safeParse(health.body);
      this.#daemonVersion = parsed.success ? parsed.data.version : undefined;
    } catch {
      this.#daemonVersion = undefined;
    }
    if (this.#stopped) return;
    this.#provisional = false;
    this.#inventory = inventory;
    try {
      this.#onRead?.(inventory);
    } catch {
      // what a device remembers is a convenience; its failure never costs the read
    }
    if (inventory.kind === 'read' && inventory.daemonName !== undefined) this.#learnName?.(inventory.daemonName);
    this.#standings = standings(inventory, this.#surfaces);
    this.#closeBlockedSockets();
    this.#ensureEvents();
    this.#settle();
    for (const listener of this.#changeListeners) listener();
    this.#planReread(inventory);
  }

  /**
   * An unreadable plugin list is asked again, after a growing wait, until it answers: a read that failed on the way
   * (a carrier that dropped, a daemon still starting) is not a verdict, and reloading the app would only repeat it. A
   * device the daemon refused is not asked again (pairing is the repair), and a protocol mismatch IS an answer.
   */
  #planReread(inventory: Inventory): void {
    if (this.#rereadTimer !== undefined) clearTimeout(this.#rereadTimer);
    this.#rereadTimer = undefined;
    if (inventory.kind !== 'unreadable') {
      this.#failedReads = 0;
      return;
    }
    const waits = this.#rereadAfterMs;
    if (this.#stopped || this.#refused || waits.length === 0) return;
    const wait = waits[Math.min(this.#failedReads, waits.length - 1)] as number;
    this.#failedReads += 1;
    this.#rereadTimer = setTimeout(() => {
      this.#rereadTimer = undefined;
      if (this.#reading !== undefined || this.#stopped) return;
      this.#reading = this.#read().finally(() => {
        this.#reading = undefined;
      });
    }, wait);
  }

  #allowed(id: string): boolean {
    return this.standing(id).state === 'allowed';
  }

  /** Waits for the inventory, then checks the caller and the owner. Throws `plugin_paused` without sending. */
  async #admit(caller: string, owner: string): Promise<void> {
    while ((this.#inventory === undefined || this.#provisional) && !this.#stopped) await this.#ready;
    // A stopped client admits nothing, whatever it remembers: a kept reference never reads from the cache alone.
    if (this.#stopped) throw stopped();
    for (const id of new Set([caller, owner])) if (!this.#allowed(id)) throw paused(id, this.standing(id));
  }

  async #call<Answer>(
    caller: string,
    route: string,
    init: Parameters<PluginClient['call']>[1] = {},
    background = false,
  ): Promise<Answer> {
    // Only the allow-listed headers cross (`allowedCallHeaders`); any other key a half passes is dropped.
    return (await this.#callWithStatus<Answer>(caller, route, init, background)).body;
  }

  /** {@link #call}, keeping the status the daemon answered with (a `202` held for the owner is not a `200`). */
  async #callWithStatus<Answer>(
    caller: string,
    route: string,
    init: Parameters<PluginClient['call']>[1] = {},
    background = false,
  ): Promise<{ readonly status: number; readonly body: Answer }> {
    const answer = await this.#answered(caller, route, init, allowedCallHeaders(init.headers), background);
    if (answer.status >= 400) throw refusal(answer);
    return { status: answer.status, body: answer.body as Answer };
  }

  /**
   * A CONDITIONAL GET (`PluginClient.conditional`): the same guarded, passkey-confirmed round trip as a call, with the
   * held tag in `If-None-Match`. A `304` is told as one (it has no body of its own: the caller holds it); a `200` carries
   * the tag the daemon named it by, when it named one. The tag is the shell's to send, so it is never a half's header.
   */
  async #conditional(
    caller: string,
    route: string,
    params: Readonly<Record<string, string>>,
    init: PluginConditionalInit = {},
    background = false,
  ): Promise<PluginConditionalAnswer> {
    const allowed = allowedCallHeaders(init.headers);
    const headers = init.ifNoneMatch === undefined ? allowed : { ...allowed, 'if-none-match': init.ifNoneMatch };
    const answer = await this.#answered(
      caller,
      route,
      { params, ...(init.query === undefined ? {} : { query: init.query }) },
      headers,
      background,
    );
    if (answer.status >= 400) throw refusal(answer);
    const etag = Object.entries(answer.headers).find(([name]) => name.toLowerCase() === 'etag')?.[1];
    if (answer.status === 304) return etag === undefined ? { status: 304 } : { status: 304, etag };
    return etag === undefined ? { status: 200, body: answer.body } : { status: 200, etag, body: answer.body };
  }

  /** One guarded round trip: admitted by the caller and the route's owner, sent, and confirmed once if a passkey is wanted. */
  async #answered(
    caller: string,
    route: string,
    init: Parameters<PluginClient['call']>[1] = {},
    headers: Record<string, string> | undefined,
    background = false,
  ): Promise<TransportAnswer> {
    const owner = this.#routeOwner.get(route);
    if (owner === undefined) throw new TypeError(`${caller} called ${route}, which no compiled manifest declares`);
    await this.#admit(caller, owner);
    const { method, path } = parseRouteKey(route);
    const request = {
      method,
      path: fillPath(path, init.params),
      ...(init.query === undefined ? {} : { query: init.query }),
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(headers === undefined ? {} : { headers }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    };
    // A resend is the same request, its request id included: the daemon sees one act asked twice, never two acts.
    // A read a person PRESSED for — sent with `quiet: false` (a Retry, the unlock press after a cancelled prompt) — is
    // theirs: it asks at once and clears the machine's "cancel stays cancelled", like any press. TRANSIENT ACTIVATION
    // ALONE NEVER MAKES A READ A PRESS: the Cancel click itself grants a few seconds of it, and a poll tick inside them
    // would clear the cancel and open the prompt again, and a poll of a machine that is off screen would open its prompt
    // while the person clicks elsewhere. Only a caller that knows it was pressed says so, with `quiet: false`.
    const read = requestOrigin(method) === 'background';
    const pressed = !background && read && init.quiet === false;
    const origin: PromptOrigin = background ? 'background' : pressed ? 'explicit' : requestOrigin(method);
    // A read sent while a person is acting on the page (not quiet, not just after a navigation) may SHOW the prompt as
    // a background read does: for the machine on screen only, never over a cancel (the gate refuses it at once while
    // that machine is dismissed) and never for a machine that is off screen (it waits, `StepUpGate.require`).
    const acting = !background && read && !pressed && init.quiet !== true && this.#personActing();
    // EVERY OTHER READ IS ONE NOBODY CAUSED (A555 r7): a page opening (a reload, a deep link, a navigation), a poll, an
    // effect a re-render re-ran, a background view's call. It never opens the prompt — its step-up refusal is its answer
    // and its unlock waits silently (`unasked`) while the shell offers one press — and the same read is answered from
    // that refusal for a while rather than sent again (`step-up-backoff.ts`).
    const unasked = origin === 'background' && !acting;
    const key = unasked ? backoffKey(request) : undefined;
    const held = key === undefined ? undefined : this.#backoff.held(key);
    if (held !== undefined) return held;
    const exempt = this.#surfaces.some(surface =>
      surface.manifest.actions?.routes?.some(def => def.key === route && def.unlockExempt === true),
    );
    const answer = await this.#confirmed(
      origin,
      unasked && !exempt && this.#lockedAnswer !== undefined ? this.#lockedAnswer : await this.#sent(request),
      async () => {
        await this.#admit(caller, owner);
        return await this.#sent(request);
      },
      init.signal,
      // Only a read can be quiet: a press asks for its step-up at once, whatever the caller said.
      init.quiet === true && requestOrigin(method) === 'background',
      unasked,
    );
    if (key !== undefined) {
      if (answer.status >= 400 && this.#need(answer) !== undefined) this.#backoff.refused(key, answer);
      else this.#backoff.forget(key);
    }
    return answer;
  }

  /**
   * ONE REQUEST, SENT AGAIN ONCE AFTER THE PERSON GIVES THE PASSKEY THE DAEMON WANTED (G105) — an unlock on opening,
   * then a step-up for the act, each at most once. Copied from today's `DaemonCarrierRouter.#confirmed`: PRESENCE COMES
   * FIRST (while the machine wants an unlock it answers everything `401 unlock_required`, so nothing else it says can
   * be read yet); a dismissed prompt returns the refusal unchanged, and a second refusal of the same kind is the answer.
   */
  async #confirmed(
    origin: PromptOrigin,
    first: TransportAnswer,
    resend: () => Promise<TransportAnswer>,
    signal?: AbortSignal,
    quiet = false,
    unasked = false,
  ): Promise<TransportAnswer> {
    const passkey = this.#passkey;
    // G95: a read is the page's own work, so its unlock waits for its machine to be on screen; a press asks at once.
    if (passkey === undefined || first.status < 400) return first;
    let answer = first;
    let need = this.#need(answer);
    if (need?.kind === 'unlock') {
      // Nobody caused this read: it waits for the unlock as every background read does, but its prompt never pops over
      // the page (the pair-success screen's unasked modal); the shell offers the press, and the read goes once confirmed.
      if (unasked) this.#setUnasked(need);
      if (!(await this.#confirm(need, unasked ? 'unasked' : origin, signal))) return answer;
      answer = await resend();
      if (answer.status < 400) return answer;
      need = this.#need(answer);
    }
    if (need?.kind !== 'step-up') return answer;
    // A quiet read (a panel mounting, a poll, a read nobody caused) is not the person acting: the refusal is the answer
    // and no prompt opens — the page offers its own "Confirm it's you" press. The daemon's refusal still stands, so
    // nothing is read or done without the step-up.
    if (unasked) this.#setUnasked(need);
    if (quiet || unasked) return answer;
    // Today's step-up wait is NOT abortable (only the unlock is), so the step-up prompt takes no signal.
    if (!(await this.#confirm(need, origin))) return answer;
    return await resend();
  }

  /** One request, its answer told to the grants cache under the generation it was sent in. */
  async #sent(request: Parameters<DaemonTransport['request']>[0]): Promise<TransportAnswer> {
    // Once this machine has refused this device (`4403`) nothing more is dialled on this client: a call that captured
    // the client before the refusal gets the same answer without asking the daemon again.
    if (this.#refused) throw new DaemonCallError(0, DEVICE_REFUSED_CODE, DEVICE_NOT_ACCEPTED_SENTENCE);
    const generation = this.#generation;
    let answer: TransportAnswer;
    try {
      answer = await this.#transport.request(request);
    } catch (error) {
      throw this.#failed(error, request.signal);
    }
    if (answer.status === 401 && this.#need(answer)?.kind === 'unlock') {
      if (generation === this.#generation) this.#lockedAnswer = answer;
      this.#signal({ kind: 'locked', generation });
    } else if (isCapabilityRefusal(answer)) this.#signal({ kind: 'refused', generation });
    return answer;
  }

  /**
   * A transport failure, told apart (S12). The caller's own abort is its own. A device-refused close (`4403`) is
   * `device_refused` (and the shell is told once, to stop dialling). A failure that says the CARRIER went away
   * ({@link isCarrierGone}) is a CARRIER OUTAGE, marked `carrier`, so a screen keeps its last good content instead of
   * saying the daemon refused. Every other failure (the daemon's own `4426` "update this app", a protocol error, no
   * device key, a plain `Error`) passes through unmarked with its own words, so it is shown, never retried silently.
   * The original is kept as `cause`.
   */
  #failed(error: unknown, signal: AbortSignal | undefined): unknown {
    if (error instanceof DaemonCallError || signal?.aborted === true) return error;
    if (isDeviceRefusal(error)) {
      this.#refuse();
      return new DaemonCallError(0, DEVICE_REFUSED_CODE, DEVICE_NOT_ACCEPTED_SENTENCE, undefined, undefined, error);
    }
    if (isCarrierGone(error))
      return new DaemonCallError(
        0,
        CARRIER_OUTAGE_CODE,
        CARRIER_OUTAGE_SENTENCE,
        undefined,
        true,
        error,
        carrierFateOf(error),
      );
    return error;
  }

  #refuse(): void {
    if (this.#refused || this.#stopped) return;
    this.#refused = true;
    for (const listener of [...this.#refusedListeners]) listener();
  }

  #signal(signal: AuthoritySignal): void {
    for (const listener of [...this.#authorityListeners]) listener(signal);
  }

  /** The handler's reading of a refusal; a handler that throws reads it as no passkey need at all. */
  #need(answer: TransportAnswer): PasskeyNeed | undefined {
    try {
      return this.#passkey?.handler.need({ status: answer.status, body: answer.body });
    } catch {
      return undefined;
    }
  }

  /**
   * The one prompt; a prompt that fails to open is a prompt not confirmed. THE UNLOCK WAIT alone honours the caller's
   * own signal (today's `untilAborted`, `relay-carrier.ts`; the step-up wait is not abortable): a background read parked behind a prompt for a machine that is not
   * on screen, whose caller stopped waiting (its deadline, an unmount), gets its refusal back as "not confirmed"
   * rather than staying parked behind a prompt nobody is going to answer for it. The prompt itself is the
   * handler's and stays; only this caller leaves it.
   */
  async #confirm(need: PasskeyNeed, origin: PromptOrigin, signal?: AbortSignal): Promise<boolean> {
    const passkey = this.#passkey;
    if (passkey === undefined || this.#stopped) return false;
    let confirmed: boolean;
    try {
      confirmed = (await untilAborted(passkey.handler.confirm(passkey.daemon, need, origin), signal, false)) === true;
    } catch {
      confirmed = false;
    }
    if (confirmed) this.noteConfirmed();
    return confirmed;
  }

  #subscribe<Name extends string, Payload>(
    caller: string,
    event: EventDef<Name, Payload>,
    listener: (payload: Payload) => void,
  ): () => void {
    const owner = eventOwner(event.name);
    // Registered at once; HEARD only while the caller and the owner are allowed (checked per frame).
    return this.#register(event, payload => {
      if (this.#allowed(caller) && this.#allowed(owner)) listener(payload as Payload);
    });
  }

  #subscribeInternal<Name extends string, Payload>(
    event: EventDef<Name, Payload>,
    listener: (p: Payload) => void,
  ): void {
    this.#register(event, listener as (payload: unknown) => void);
  }

  #register(event: EventDef, listener: (payload: unknown) => void): () => void {
    let subscription = this.#subscriptions.get(event.name);
    if (subscription === undefined) {
      subscription = { def: event, listeners: new Set() };
      this.#subscriptions.set(event.name, subscription);
    }
    subscription.listeners.add(listener);
    this.#ensureEvents();
    return () => {
      subscription.listeners.delete(listener);
      if (subscription.listeners.size === 0) this.#subscriptions.delete(event.name);
    };
  }

  /** The event stream opens only after the bootstrap read, and only while something listens. */
  #ensureEvents(): void {
    if (this.#stopEvents !== undefined || this.#inventory === undefined || this.#provisional || this.#stopped) return;
    if (this.#subscriptions.size === 0) return;
    this.#stopEvents = this.#transport.events(
      raw => {
        const owner = eventOwner(raw.name);
        const subscription = this.#subscriptions.get(raw.name);
        // No decoder for an event nobody subscribed to, or whose package is blocked: dropped UNPARSED.
        if (subscription === undefined) return;
        if (owner !== 'kernel' && !this.#allowed(owner)) return;
        const parsed = subscription.def.schema.safeParse(raw.payload);
        if (!parsed.success) return;
        for (const listener of subscription.listeners) listener(parsed.data);
      },
      () => {
        this.#stopEvents = undefined;
        this.#setFeedLive(false);
      },
      () => this.#setFeedLive(true),
    );
  }

  #socket(
    caller: string,
    key: string,
    params: Readonly<Record<string, string>>,
    listeners: SocketListeners,
    query?: Readonly<Record<string, string>>,
  ): TransportSocket {
    const owner = this.#socketOwner.get(key);
    if (owner === undefined) throw new TypeError(`${caller} opened ${key}, which no compiled manifest declares`);
    if (this.#stopped) throw stopped();
    // A remembered list only DRAWS: no socket opens on it. The handle is returned at once and the socket opens only when
    // the LIVE list has answered (or closes as paused if that list says no), so a view that opens its socket in an
    // effect on a reload is never thrown at while the live read is still on its way.
    if (this.#provisional || this.#inventory === undefined || this.#inventory.kind === 'unreadable')
      return this.#deferSocket(caller, owner, key, params, listeners, query);
    return this.#openSocket(caller, owner, key, params, listeners, query);
  }

  #deferSocket(
    caller: string,
    owner: string,
    key: string,
    params: Readonly<Record<string, string>>,
    listeners: SocketListeners,
    query?: Readonly<Record<string, string>>,
  ): TransportSocket {
    let inner: TransportSocket | undefined;
    let closed = false;
    const abandon = (): void => {
      if (closed) return;
      closed = true;
      listeners.onClose('This connection was closed.', 1008);
    };
    this.#waitingSockets.add(abandon);
    void (async () => {
      while ((this.#inventory === undefined || this.#provisional) && !this.#stopped) await this.#ready;
      this.#waitingSockets.delete(abandon);
      if (closed || this.#stopped) return;
      try {
        inner = this.#openSocket(caller, owner, key, params, listeners, query);
      } catch {
        closed = true;
        // A list that could not be read is no verdict: the close is retryable (no code), and the re-read plan answers by
        // the time the view dials again. A live list that says no is a refusal (1008), which a view does not dial again.
        if (this.#inventory?.kind === 'unreadable') listeners.onClose(KERNEL_REFUSALS.pluginPaused.code);
        else listeners.onClose(KERNEL_REFUSALS.pluginPaused.code, 1008);
      }
    })();
    return {
      send: frame => {
        if (closed) return;
        // Before the live answer nothing is open: a frame sent now is dropped, as the transport drops one sent before open.
        inner?.send(frame);
      },
      close: (code, reason) => {
        if (closed) return;
        closed = true;
        inner?.close(code, reason);
      },
    };
  }

  #openSocket(
    caller: string,
    owner: string,
    key: string,
    params: Readonly<Record<string, string>>,
    listeners: SocketListeners,
    query?: Readonly<Record<string, string>>,
  ): TransportSocket {
    for (const id of new Set([caller, owner])) if (!this.#allowed(id)) throw paused(id, this.standing(id));
    const { path } = parseRouteKey(key);
    const entry: { open?: OpenSocket } = {};
    const queryString = new URLSearchParams(query ?? {}).toString();
    const opened = fillPath(path, params);
    const socket = this.#transport.socket(queryString === '' ? opened : `${opened}?${queryString}`, {
      ...(listeners.onOpen === undefined ? {} : { onOpen: listeners.onOpen }),
      onFrame: listeners.onFrame,
      onClose: (reason, code) => {
        if (entry.open !== undefined) this.#sockets.delete(entry.open);
        listeners.onClose(reason, code);
      },
    });
    entry.open = { ids: [caller, owner], socket, listeners };
    this.#sockets.add(entry.open);
    return {
      send: frame => socket.send(frame),
      close: (code, reason) => {
        if (entry.open !== undefined) this.#sockets.delete(entry.open);
        socket.close(code, reason);
      },
    };
  }

  #closeBlockedSockets(): void {
    for (const open of [...this.#sockets]) {
      if (open.ids.every(id => this.#allowed(id))) continue;
      this.#sockets.delete(open);
      open.socket.close();
      open.listeners.onClose(KERNEL_REFUSALS.pluginPaused.code);
    }
  }
}
