import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { ClientDeps, Surfaces } from './client.ts';
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
  /** The guarded client of this invocation. Opening it reads the credential and may start the daemon. */
  deps(): Promise<ClientDeps>;
}

export type ShellVerb = (context: ShellContext) => Promise<number>;
