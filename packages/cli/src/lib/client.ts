/**
 * The one generated-style client every `fy` verb and agent tool talks through (§9.6). Per plugin it:
 *
 * 1. refuses a person-only route from a ferret's pane BEFORE any contact with the daemon (S59, S61);
 * 2. reads the plugin inventory (the safe bootstrap read) and blocks the call, unsent, unless every core package and
 *    the owning plugin are present, on and carry this fy's contract hashes. A block re-reads once, so a daemon that
 *    restarted on a new build is not judged by its old inventory. The held inventory is dropped when the daemon
 *    restarts (its run record names another process), when `kernel.plugins-changed` is heard, and before a request
 *    is sent again after the daemon was away: nothing resumes before the fresh check;
 * 3. sends, and turns an HTTP refusal into a final `DaemonRefusal` (S54).
 */
import { type PluginInventory, PluginsChanged } from '@ferretry/kernel/contract';
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

/** The client a plugin's half gets as `ctx.client`. */
export function pluginClient(deps: ClientDeps, caller: Manifest['id']): PluginClient {
  return {
    async call<Answer = unknown>(route: string, init?: CallInit): Promise<Answer> {
      const facts = routeFactsBeforeContact(deps.surfaces, deps.inPane, route);
      const request = buildRequest(route, init);
      const ids = [caller, facts.owner];
      await ensureAllAllowed(deps, ids);
      return (await sendChecked(deps, request, ids)) as Answer;
    },
    subscribe() {
      throw new ShellError(`${deps.binary} does not subscribe to events in this build`, EXIT.unavailable);
    },
  };
}
