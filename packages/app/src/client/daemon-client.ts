import { KERNEL_REFUSALS, PluginsChanged, parseRouteKey } from '@ferretry/kernel/contract';
import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { SurfaceEntry } from '../surfaces/registry.ts';
import { eventOwner, type Inventory, parseInventory, type Standing, standings } from './inventory.ts';
import {
  DaemonCallError,
  type DaemonTransport,
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
 */

const HealthEnvelopeSchema = z.object({ protocol: z.number().int(), version: z.string().max(64) });

export const INVENTORY_ROUTE = 'GET /v1/plugins';
export const HEALTH_ROUTE = 'GET /v1/health';

export interface DaemonClientOptions {
  readonly transport: DaemonTransport;
  readonly surfaces: readonly SurfaceEntry[];
}

/** The shell's widening of the leaf's `PluginClient`: the same guard over sockets. */
export interface ShellPluginClient extends PluginClient {
  socket(key: string, params: Readonly<Record<string, string>>, listeners: SocketListeners): TransportSocket;
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

/** `/v1/board/:id` + `{ id: 'F 1' }` → `/v1/board/F%201`. A missing parameter is a programming error. */
export function fillPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new TypeError(`route ${template} needs the parameter "${name}"`);
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
  return new DaemonCallError(answer.status, code, message);
}

export class DaemonClient {
  readonly #transport: DaemonTransport;
  readonly #surfaces: readonly SurfaceEntry[];
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
  #stopReconnect: (() => void) | undefined;
  #stopped = false;

  constructor(options: DaemonClientOptions) {
    this.#transport = options.transport;
    this.#surfaces = options.surfaces;
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

  /** Fires after every inventory change; the shell re-renders from {@link standing}. */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** The client one package's half talks through. Every call is guarded by the OWNER of the route it names. */
  forPackage(caller: string): ShellPluginClient {
    return {
      call: (route, init) => this.#call(caller, route, init),
      subscribe: (event, listener) => this.#subscribe(caller, event, listener),
      socket: (key, params, listeners) => this.#socket(caller, key, params, listeners),
    };
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
    } catch {
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

  async #call<Answer>(caller: string, route: string, init: Parameters<PluginClient['call']>[1] = {}): Promise<Answer> {
    const owner = this.#routeOwner.get(route);
    if (owner === undefined) throw new TypeError(`${caller} called ${route}, which no compiled manifest declares`);
    await this.#admit(caller, owner);
    const { method, path } = parseRouteKey(route);
    const answer = await this.#transport.request({
      method,
      path: fillPath(path, init.params),
      ...(init.query === undefined ? {} : { query: init.query }),
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (answer.status >= 400) throw refusal(answer);
    return answer.body as Answer;
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
      },
    );
  }

  #socket(
    caller: string,
    key: string,
    params: Readonly<Record<string, string>>,
    listeners: SocketListeners,
  ): TransportSocket {
    const owner = this.#socketOwner.get(key);
    if (owner === undefined) throw new TypeError(`${caller} opened ${key}, which no compiled manifest declares`);
    // A socket is synchronous: it cannot wait for the inventory, so an unread inventory refuses like a block.
    for (const id of new Set([caller, owner])) if (!this.#allowed(id)) throw paused(id, this.standing(id));
    const { path } = parseRouteKey(key);
    const entry: { open?: OpenSocket } = {};
    const socket = this.#transport.socket(fillPath(path, params), {
      onFrame: listeners.onFrame,
      onClose: reason => {
        if (entry.open !== undefined) this.#sockets.delete(entry.open);
        listeners.onClose(reason);
      },
    });
    entry.open = { ids: [caller, owner], socket, listeners };
    this.#sockets.add(entry.open);
    return {
      send: frame => socket.send(frame),
      close: () => {
        if (entry.open !== undefined) this.#sockets.delete(entry.open);
        socket.close();
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
