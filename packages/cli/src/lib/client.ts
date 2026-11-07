/**
 * The one generated-style client every `fy` verb and agent tool talks through (§9.6). Per plugin it:
 *
 * 1. refuses a person-only route from a ferret's pane BEFORE any contact with the daemon (S59, S61);
 * 2. reads the plugin inventory once (the safe bootstrap read) and blocks the call, unsent, unless the owning
 *    plugin is present, on and has this fy's contract hash. A block re-reads once, so a daemon that restarted on a
 *    new build is not judged by its old inventory;
 * 3. sends, and turns an HTTP refusal into a final `DaemonRefusal` (S54).
 */
import type { PluginInventory } from '@ferretry/kernel/contract';
import type { Manifest, PluginClient } from '@ferretry/kernel/manifest';
import { DaemonRefusal, EXIT, ShellError } from './errors.ts';
import { type CompiledContracts, judgePlugin, PluginPausedError, pausedSentence } from './guard.ts';
import { PERSON_ONLY_REFUSAL } from './credential.ts';
import type { CommandRegistry } from './registry.ts';
import { buildRequest, type CallInit, type DaemonRequest, isRepeatable, refusalText } from './request.ts';

export interface DaemonReply {
  readonly status: number;
  readonly body: unknown;
}

/** Sends one request, with whatever credential the connection chose. Never throws for an HTTP status. */
export interface DaemonTransport {
  send(request: DaemonRequest, options: { readonly repeatable: boolean }): Promise<DaemonReply>;
}

/** The inventory, read once and re-read on demand. */
export class InventoryCache {
  #held: Promise<PluginInventory> | undefined;

  constructor(private readonly read: () => Promise<PluginInventory>) {}

  current(): Promise<PluginInventory> {
    this.#held ??= this.#fresh();
    return this.#held;
  }

  refresh(): Promise<PluginInventory> {
    this.#held = this.#fresh();
    return this.#held;
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
  for (const plugin of registry.plugins) {
    titles[plugin.id] = plugin.manifest.title;
    compiled[plugin.id] = plugin.contract;
    for (const route of plugin.manifest.actions?.routes ?? [])
      if (!routes.has(route.key)) routes.set(route.key, { owner: plugin.id, caller: route.caller });
    for (const tool of plugin.manifest.actions?.agentTools ?? [])
      tools.set(toolKey(plugin.id, tool.name), { owner: plugin.id, caller: tool.caller });
  }
  return { routes, tools, titles, compiled };
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
  let verdict = judgePlugin(await inventory.current(), surfaces.compiled, id);
  if (!verdict.ok) verdict = judgePlugin(await inventory.refresh(), surfaces.compiled, id);
  if (verdict.ok) return;
  throw new PluginPausedError(id, verdict.reason, pausedSentence(verdict, surfaces.titles[id] ?? id, id, binary));
}

export async function sendChecked(deps: ClientDeps, request: DaemonRequest): Promise<unknown> {
  const reply = await deps.transport.send(request, { repeatable: isRepeatable(request.method) });
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
      const facts = deps.surfaces.routes.get(route);
      if (facts === undefined) throw new ShellError(`no plugin declares the route ${route}`, EXIT.failure);
      if (deps.inPane && facts.caller === 'person') throw new ShellError(PERSON_ONLY_REFUSAL, EXIT.failure);
      const request = buildRequest(route, init);
      await ensureAllowed(deps, caller);
      if (facts.owner !== caller) await ensureAllowed(deps, facts.owner);
      return (await sendChecked(deps, request)) as Answer;
    },
    subscribe() {
      throw new ShellError(`${deps.binary} does not subscribe to events in this build`, EXIT.unavailable);
    },
  };
}
