import { KERNEL_REFUSALS, PluginsChanged, parseRouteKey } from '@ferretry/kernel/contract';
import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginCallHeaders, PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { PairedDaemon } from '../daemons/daemon-list.ts';
import { type PasskeyHandler, type PasskeyNeed, type PromptOrigin, requestOrigin } from '../passkey/passkey.ts';
import type { SurfaceEntry } from '../surfaces/registry.ts';
import { untilAborted } from './machine-deadline.ts';
import { DEVICE_NOT_ACCEPTED_SENTENCE } from './sentences.ts';
import { eventOwner, type Inventory, parseInventory, type Standing, standings } from './inventory.ts';
import {
  CARRIER_OUTAGE_CODE,
  DaemonCallError,
  type DaemonTransport,
  DEVICE_REFUSED_CODE,
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

/** The agenda channel header and the one value it may carry (the Asks contract's `AGENDA_CHANNEL_HEADER` / `AGENDA_CHANNEL_VERSION`). */
const AGENDA_CHANNEL_HEADER = 'x-fy-agenda-channel';
const AGENDA_CHANNEL_VERSIONS: ReadonlySet<string> = new Set(['2']);

/**
 * The CLOSED list of headers a half may set (`PluginCallHeaders`): `x-fy-request-id` and `x-fy-agenda-channel` with
 * today's value. Any other key a half passes is dropped, and so is a channel value outside the list; nothing else
 * (credentials, the contract hash) is ever a half's to send.
 */
const allowedHeaders = (given: PluginCallHeaders | undefined): Record<string, string> | undefined => {
  if (given === undefined) return undefined;
  const sent: Record<string, string> = {};
  const requestId = given['x-fy-request-id'];
  if (requestId !== undefined) sent['x-fy-request-id'] = requestId;
  const channel = given[AGENDA_CHANNEL_HEADER];
  if (channel !== undefined && AGENDA_CHANNEL_VERSIONS.has(channel)) sent[AGENDA_CHANNEL_HEADER] = channel;
  return Object.keys(sent).length === 0 ? undefined : sent;
};

export interface DaemonClientOptions {
  readonly transport: DaemonTransport;
  readonly surfaces: readonly SurfaceEntry[];
  /**
   * The daemon this client reaches and Access's passkey handler (`passkey/passkey.ts`): a refusal for want of an
   * unlock or a step-up is shown to it, and the call is sent again ONCE when the person confirmed. Absent, nothing can
   * ask and every refusal is returned as it came.
   */
  readonly passkey?: { readonly daemon: PairedDaemon; readonly handler: PasskeyHandler };
}

/**
 * Who a package client's calls are on behalf of, for the passkey (S2): `ordinary` asks as the request's method says
 * (a read waits for its machine to be on screen, a press asks at once); `background` makes EVERY call a background
 * read, whatever its method, so a background view never raises a prompt for a machine that is not on screen.
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

function refusal(answer: TransportAnswer): DaemonCallError {
  const body = typeof answer.body === 'object' && answer.body !== null ? (answer.body as Record<string, unknown>) : {};
  const code = typeof body.code === 'string' ? body.code : `http_${answer.status}`;
  const message = typeof body.error === 'string' ? body.error : `The daemon answered ${answer.status}.`;
  return new DaemonCallError(answer.status, code, message, answer.body);
}

export class DaemonClient {
  readonly #transport: DaemonTransport;
  readonly #surfaces: readonly SurfaceEntry[];
  readonly #passkey: DaemonClientOptions['passkey'];
  /** Which package declares each route and socket key, across every compiled manifest. */
  readonly #routeOwner = new Map<string, string>();
  readonly #socketOwner = new Map<string, string>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #sockets = new Set<OpenSocket>();
  readonly #changeListeners = new Set<() => void>();
  #inventory: Inventory | undefined;
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

  constructor(options: DaemonClientOptions) {
    this.#transport = options.transport;
    this.#surfaces = options.surfaces;
    this.#passkey = options.passkey;
    for (const entry of options.surfaces) {
      for (const route of entry.manifest.actions?.routes ?? []) this.#routeOwner.set(route.key, entry.id);
      for (const socket of entry.manifest.actions?.sockets ?? []) this.#socketOwner.set(socket.key, entry.id);
    }
    this.#standings = standings(undefined, this.#surfaces);
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
    this.#stopEvents?.();
    this.#stopEvents = undefined;
    this.#setFeedLive(false);
    this.#stopReconnect?.();
    for (const open of this.#sockets) open.socket.close();
    this.#sockets.clear();
  }

  /** Re-reads the inventory. Calls made meanwhile wait; nothing else is sent until it answers. */
  refresh(): Promise<void> {
    if (this.#reading !== undefined) return this.#reading;
    if (this.#inventory !== undefined) {
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
    this.#generation += 1;
    this.#signal({ kind: 'confirmed' });
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
      const answer = await this.#transport.request({ method: 'GET', path: parseRouteKey(INVENTORY_ROUTE).path });
      inventory = answer.status === 200 ? parseInventory(answer.body) : { kind: 'unreadable' };
    } catch (error) {
      if (isDeviceRefusal(error)) this.#refuse();
      inventory = { kind: 'unreadable' };
    }
    try {
      const health = await this.#transport.request({ method: 'GET', path: parseRouteKey(HEALTH_ROUTE).path });
      const parsed = HealthEnvelopeSchema.safeParse(health.body);
      this.#daemonVersion = parsed.success ? parsed.data.version : undefined;
    } catch {
      this.#daemonVersion = undefined;
    }
    if (this.#stopped) return;
    this.#inventory = inventory;
    this.#standings = standings(inventory, this.#surfaces);
    this.#closeBlockedSockets();
    this.#ensureEvents();
    this.#settle();
    for (const listener of this.#changeListeners) listener();
  }

  #allowed(id: string): boolean {
    return this.standing(id).state === 'allowed';
  }

  /** Waits for the inventory, then checks the caller and the owner. Throws `plugin_paused` without sending. */
  async #admit(caller: string, owner: string): Promise<void> {
    while (this.#inventory === undefined && !this.#stopped) await this.#ready;
    for (const id of new Set([caller, owner])) if (!this.#allowed(id)) throw paused(id, this.standing(id));
  }

  async #call<Answer>(
    caller: string,
    route: string,
    init: Parameters<PluginClient['call']>[1] = {},
    background = false,
  ): Promise<Answer> {
    const owner = this.#routeOwner.get(route);
    if (owner === undefined) throw new TypeError(`${caller} called ${route}, which no compiled manifest declares`);
    await this.#admit(caller, owner);
    const { method, path } = parseRouteKey(route);
    // Only the allow-listed headers cross (`allowedHeaders`); any other key a half passes is dropped.
    const headers = allowedHeaders(init.headers);
    const request = {
      method,
      path: fillPath(path, init.params),
      ...(init.query === undefined ? {} : { query: init.query }),
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(headers === undefined ? {} : { headers }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    };
    // A resend is the same request, its request id included: the daemon sees one act asked twice, never two acts.
    const answer = await this.#confirmed(
      background ? 'background' : requestOrigin(method),
      await this.#sent(request),
      async () => {
        await this.#admit(caller, owner);
        return await this.#sent(request);
      },
      init.signal,
    );
    if (answer.status >= 400) throw refusal(answer);
    return answer.body as Answer;
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
  ): Promise<TransportAnswer> {
    const passkey = this.#passkey;
    // G95: a read is the page's own work, so its prompt waits for its machine to be on screen; a press asks at once.
    if (passkey === undefined || first.status < 400) return first;
    let answer = first;
    let need = this.#need(answer);
    if (need?.kind === 'unlock') {
      if (!(await this.#confirm(need, origin, signal))) return answer;
      answer = await resend();
      if (answer.status < 400) return answer;
      need = this.#need(answer);
    }
    if (need?.kind !== 'step-up') return answer;
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
    if (answer.status === 401 && this.#need(answer)?.kind === 'unlock') this.#signal({ kind: 'locked', generation });
    else if (isCapabilityRefusal(answer)) this.#signal({ kind: 'refused', generation });
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
      return new DaemonCallError(0, CARRIER_OUTAGE_CODE, CARRIER_OUTAGE_SENTENCE, undefined, true, error);
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
    if (this.#stopEvents !== undefined || this.#inventory === undefined || this.#stopped) return;
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
    // A socket is synchronous: it cannot wait for the inventory, so an unread inventory refuses like a block.
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
