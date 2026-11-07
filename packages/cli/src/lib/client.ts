/**
 * The one generated-style client every `fy` verb and agent tool talks through (§9.6). Per plugin it:
 *
 * 1. refuses a person-only route from a ferret's pane BEFORE any contact with the daemon (S59, S61);
 * 2. reads the plugin inventory (the safe bootstrap read) and blocks the call, unsent, unless every core package and
 *    the owning plugin are present, on and carry this fy's contract hashes. A block re-reads once, so a daemon that
 *    restarted on a new build is not judged by its old inventory. The held inventory is dropped when the daemon
 *    restarts (its run record names another process), when `kernel.plugins-changed` is heard, and before a request
 *    is sent again after the daemon was away. A guarded resend therefore waits for a fresh inventory check; that
 *    read, like every attempt of every request, goes through the transport's own per-attempt address check;
 * 3. sends, and turns an HTTP refusal into a final `DaemonRefusal` (S54).
 *
 * What holds for the credential (S57) is the transport's, not this client's: the HTTP transport reads the daemon's
 * address again on EVERY attempt, a resend after a restart included, and asks its locality and own-listener check
 * about exactly that address before the request (and its credential) goes out. A refusal there is final. The
 * remaining window is the moment between that check and the connect, which no user-space client can close.
 */
import { type Cancel, type EventDef, type PluginInventory, PluginsChanged } from '@ferretry/kernel/contract';
import type { Manifest, PluginClient } from '@ferretry/kernel/manifest';
import { DaemonRefusal, EXIT, ShellError } from './errors.ts';
import { type CompiledContracts, judgeCall, PluginPausedError, pausedSentence } from './guard.ts';
import { PERSON_ONLY_REFUSAL } from './credential.ts';
import type { CommandRegistry } from './registry.ts';
import { buildRequest, type CallInit, type DaemonRequest, isRepeatable, refusalText } from './request.ts';

export interface DaemonReply {
  readonly status: number;
  readonly body: unknown;
}

export interface SendOptions {
  readonly repeatable: boolean;
  /**
   * Asked before the request is sent AGAIN after the daemon was away (a restart): the guard's fresh check. It throws
   * to stop the resend. The first attempt does not ask it; the caller checked before sending.
   */
  readonly recheck?: () => Promise<void>;
}

/** Sends one request, with whatever credential the connection chose. Never throws for an HTTP status. */
export interface DaemonTransport {
  send(request: DaemonRequest, options: SendOptions): Promise<DaemonReply>;
  /**
   * Opens the daemon's event feed (`/v1/events`): every event is handed over raw, and `onClose` says why it ended.
   * Returns the cancel. Absent where a transport cannot hold a feed open.
   */
  events?(listener: (event: RawEvent) => void, onClose: (reason: string) => void): Cancel;
}

/**
 * The inventory, read once per daemon process and re-read on demand. `instance` names the daemon process now
 * recorded (its run record's pid), or `undefined` where none is known: a different answer drops the held inventory.
 */
export class InventoryCache {
  #held: Promise<PluginInventory> | undefined;
  #heldFor: string | undefined;

  constructor(
    private readonly read: () => Promise<PluginInventory>,
    private readonly instance: () => Promise<string | undefined> = async () => undefined,
  ) {}

  async current(): Promise<PluginInventory> {
    const now = await this.instance();
    if (this.#held !== undefined && now !== this.#heldFor) this.#held = undefined;
    if (this.#held === undefined) {
      this.#heldFor = now;
      this.#held = this.#fresh();
    }
    return await this.#held;
  }

  async refresh(): Promise<PluginInventory> {
    this.#heldFor = await this.instance();
    this.#held = this.#fresh();
    return await this.#held;
  }

  /** Forgets the held answer: the next check reads the inventory again. */
  invalidate(): void {
    this.#held = undefined;
  }

  /** An event this connection heard. `kernel.plugins-changed` (a plugin turned on or off, a new build) drops the inventory. */
  heard(eventName: string): void {
    if (eventName === PluginsChanged.name) this.invalidate();
  }

  #fresh(): Promise<PluginInventory> {
    const reading = this.read();
    reading.catch(() => {
      if (this.#held === reading) this.#held = undefined;
    });
    return reading;
  }
}

interface RouteFacts {
  readonly owner: string;
  readonly caller: 'person' | 'any';
}

/** Every route and tool the registry's manifests declare, by key. The first declaration of a key keeps it. */
export interface Surfaces {
  readonly routes: ReadonlyMap<string, RouteFacts>;
  readonly tools: ReadonlyMap<string, RouteFacts>;
  readonly titles: Readonly<Record<string, string>>;
  readonly compiled: CompiledContracts;
}

export const toolKey = (plugin: string, name: string): string => `${plugin}/${name}`;

export function surfacesOf(registry: CommandRegistry): Surfaces {
  const routes = new Map<string, RouteFacts>();
  const tools = new Map<string, RouteFacts>();
  const titles: Record<string, string> = {};
  const compiled: Record<string, string> = {};
  for (const plugin of [{ id: registry.kernel.manifest.id, ...registry.kernel }, ...registry.plugins]) {
    titles[plugin.id] = plugin.manifest.title;
    compiled[plugin.id] = plugin.contract;
    for (const route of plugin.manifest.actions?.routes ?? [])
      if (!routes.has(route.key)) routes.set(route.key, { owner: plugin.id, caller: route.caller });
    for (const tool of plugin.manifest.actions?.agentTools ?? [])
      tools.set(toolKey(plugin.id, tool.name), { owner: plugin.id, caller: tool.caller });
  }
  return { routes, tools, titles, compiled };
}

/**
 * What a route call must pass before anything is opened (S59, S61): the route is declared, and a person-only route is
 * not called from a ferret's pane. Asked before the connection exists, so a refusal never contacts or starts a daemon.
 */
export function routeFactsBeforeContact(surfaces: Surfaces, inPane: boolean, route: string): RouteFacts {
  const facts = surfaces.routes.get(route);
  if (facts === undefined) throw new ShellError(`no plugin declares the route ${route}`, EXIT.failure);
  if (inPane && facts.caller === 'person') throw new ShellError(PERSON_ONLY_REFUSAL, EXIT.failure);
  return facts;
}

export interface ClientDeps {
  readonly transport: DaemonTransport;
  readonly inventory: InventoryCache;
  readonly surfaces: Surfaces;
  /** Whether this process runs inside a ferret's pane. */
  readonly inPane: boolean;
  readonly binary: string;
}

/** Throws `PluginPausedError` when the plugin may not be called. Re-reads the inventory once before blocking. */
export async function ensureAllowed(deps: ClientDeps, id: string): Promise<void> {
  const { inventory, surfaces, binary } = deps;
  let verdict = judgeCall(await inventory.current(), surfaces.compiled, id);
  if (!verdict.ok) verdict = judgeCall(await inventory.refresh(), surfaces.compiled, id);
  if (verdict.ok) return;
  const named = verdict.reason === 'core' ? verdict.core : id;
  throw new PluginPausedError(
    named,
    verdict.reason,
    pausedSentence(verdict, surfaces.titles[named] ?? named, named, binary),
  );
}

/** The guard for every package one request needs; also what is asked again before a resend after a restart. */
async function ensureAllAllowed(deps: ClientDeps, ids: readonly string[]): Promise<void> {
  for (const id of new Set(ids)) await ensureAllowed(deps, id);
}

/**
 * Sends `request`, already guarded for `ids`. If the daemon was away and the request is to be sent again, the held
 * inventory is dropped and `ids` are checked afresh first: a daemon that came back on another build or with a plugin
 * off is judged by what it says now.
 */
export async function sendChecked(deps: ClientDeps, request: DaemonRequest, ids: readonly string[]): Promise<unknown> {
  const reply = await deps.transport.send(request, {
    repeatable: isRepeatable(request.method),
    recheck: async () => {
      deps.inventory.invalidate();
      await ensureAllAllowed(deps, ids);
    },
  });
  if (reply.status >= 400) {
    const refusal = refusalText(reply.status, reply.body);
    throw new DaemonRefusal(refusal.message, reply.status, refusal.code);
  }
  return reply.body;
}

/** One event as the daemon's feed carries it, before anyone has checked its payload. */
export interface RawEvent {
  readonly name: string;
  readonly payload: unknown;
}

/** The package that owns an event: the words before its first dot (`ferrets.changed` is Ferrets'). */
export const eventOwner = (eventName: string): string => {
  const dot = eventName.indexOf('.');
  return dot === -1 ? eventName : eventName.slice(0, dot);
};

/** A client that can also be told when its feed ends, which a verb that follows events until interrupted needs. */
export interface FollowingClient extends PluginClient {
  /**
   * Like `subscribe`, and `onEnd` is told why when the feed can no longer deliver: the connection was refused, or the
   * daemon went away. After `onEnd` nothing more is delivered. The returned cancel never calls `onEnd`.
   */
  follow<Name extends string, Payload>(
    event: EventDef<Name, Payload>,
    listener: (payload: Payload) => void,
    onEnd: (reason: string) => void,
  ): Cancel;
}

interface Following {
  readonly event: EventDef;
  readonly deliver: (payload: unknown) => void;
  readonly end: (reason: string) => void;
}

/**
 * The one event feed of a connection: opened on the first listener, closed when the last one leaves. A frame of an
 * event nobody follows is dropped UNPARSED. `kernel.plugins-changed` is heard here too, so a held inventory is dropped
 * by the same frame that tells a follower about it.
 */
class EventFeed {
  readonly #following = new Set<Following>();
  #stop: (() => void) | undefined;

  constructor(private readonly deps: ClientDeps) {}

  add(following: Following): Cancel {
    const open = this.deps.transport.events;
    if (open === undefined)
      throw new ShellError(`${this.deps.binary} does not subscribe to events on this connection`, EXIT.unavailable);
    this.#following.add(following);
    if (this.#stop === undefined) {
      this.#stop = open.call(
        this.deps.transport,
        raw => this.#heard(raw),
        reason => this.#closed(reason),
      );
    }
    return () => {
      this.#following.delete(following);
      if (this.#following.size === 0) {
        this.#stop?.();
        this.#stop = undefined;
      }
    };
  }

  #heard(raw: RawEvent): void {
    this.deps.inventory.heard(raw.name);
    for (const following of this.#following) {
      if (following.event.name !== raw.name) continue;
      const parsed = following.event.schema.safeParse(raw.payload);
      if (parsed.success) following.deliver(parsed.data);
    }
  }

  #closed(reason: string): void {
    const ended = [...this.#following];
    this.#following.clear();
    this.#stop = undefined;
    for (const following of ended) following.end(reason);
  }
}

const feeds = new WeakMap<ClientDeps, EventFeed>();
const feedOf = (deps: ClientDeps): EventFeed => {
  let feed = feeds.get(deps);
  if (feed === undefined) {
    feed = new EventFeed(deps);
    feeds.set(deps, feed);
  }
  return feed;
};

/**
 * The client a plugin's half gets as `ctx.client`. An event is HEARD only while the caller and the event's owner are
 * allowed, asked again for every frame; a frame that fails the check is dropped, unseen.
 */
export function pluginClient(deps: ClientDeps, caller: Manifest['id']): FollowingClient {
  const follow: FollowingClient['follow'] = (event, listener, onEnd) => {
    const ids = [caller, eventOwner(event.name)];
    // One chain per listener, so frames reach it in the order they arrived even though each is checked asynchronously.
    let chain: Promise<void> = Promise.resolve();
    let live = true;
    const cancel = feedOf(deps).add({
      event,
      deliver: payload => {
        chain = chain.then(async () => {
          try {
            await ensureAllAllowed(deps, ids);
          } catch {
            return;
          }
          if (live) listener(payload as never);
        });
      },
      end: reason => {
        chain = chain.then(() => {
          if (live) onEnd(reason);
        });
      },
    });
    return () => {
      live = false;
      cancel();
    };
  };
  return {
    async call<Answer = unknown>(route: string, init?: CallInit): Promise<Answer> {
      const facts = routeFactsBeforeContact(deps.surfaces, deps.inPane, route);
      const request = buildRequest(route, init);
      const ids = [caller, facts.owner];
      await ensureAllAllowed(deps, ids);
      return (await sendChecked(deps, request, ids)) as Answer;
    },
    subscribe: (event, listener) => follow(event, listener, () => undefined),
    follow,
  };
}
