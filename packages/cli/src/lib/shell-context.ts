import type { Manifest, VerbInvocation } from '@ferretry/kernel/manifest';
import type { ClientDeps, FollowingClient, Surfaces } from './client.ts';
import type { PluginGraph } from './plugin-graph.ts';
import type { VerbTable } from './verbs.ts';
import type { CliWorld } from './world.ts';

/** What a shell-owned verb is handed. */
export interface ShellContext {
  readonly world: CliWorld;
  readonly invocation: VerbInvocation;
  readonly table: VerbTable;
  readonly surfaces: Surfaces;
  readonly graph: PluginGraph;
  /**
   * The guarded client of this invocation, speaking as `caller`, the same one a plugin verb gets: it opens lazily, and a
   * route call is judged (declared, and not person-only from a ferret's pane) BEFORE it opens, so a refusal never
   * probes, starts or sends anything to a daemon (S59). Every route call a shell verb makes goes through it.
   */
  client(caller: Manifest['id']): FollowingClient;
  /**
   * The connection itself, for a verb that reads the plugin inventory (doctor, daemon, plugin). A route call goes
   * through {@link client} instead. Opening it reads the credential and may start the daemon.
   */
  deps(): Promise<ClientDeps>;
}

export type ShellVerb = (context: ShellContext) => Promise<number>;
