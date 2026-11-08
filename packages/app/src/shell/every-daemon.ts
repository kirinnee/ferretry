import type { PluginClient } from '@ferretry/kernel/manifest';
import { useSyncExternalStore } from 'react';
import type { ClientOrigin } from '../client/daemon-client.ts';
import { daemonTitle } from '../daemons/daemon-list.ts';
import { appHookProviders } from '../surfaces/app-hooks.ts';
import { type NoReach, type PluginReach, usePluginIdentity } from './plugin-identity.tsx';
import type { ShellRuntime } from './runtime.ts';
import type { Authority, Axis, CapabilityName } from './view-place.tsx';

/**
 * THE SAME PLUGIN ON EVERY MACHINE (shell contract S2): one row per paired daemon where the calling plugin is on and
 * allowed, each with that machine's place (S1) and the plugin's OWN guarded client there, from the one client cache.
 *
 * - The caller is the plugin-identity context (`plugin-identity.tsx`), never a package id: no hook takes one.
 * - A row appears once that daemon's client exists and goes when the plugin is blocked, paused or unpaired there. A
 *   machine whose feed is down keeps its row with `online: false`.
 * - The shell adds no authority: the client is the one the half's views use, under the daemon's own guard.
 */

export interface DaemonReach {
  readonly daemon: string;
  readonly machine: string;
  readonly online: boolean;
  /** S1's cache says this machine wants an unlock (its grants read answered `401 unlock_required`). */
  readonly locked: boolean;
  /** S1's answers for THIS machine, from the one cache: a row applies `controlState` like a view. */
  readonly authority: (capability: CapabilityName, axis: Axis) => Authority;
  readonly authorityOf: (route: string) => Authority;
  /** The person's explicit unlock (a press, never on mount). Asks at once; does NOT move the passkey's focus. */
  readonly unlock: () => Promise<boolean>;
  /** As `ViewPlace.press`, for this machine: `locked` → unlock first, then the act; dismissed → `undefined`. */
  readonly press: <T>(act: () => Promise<T>) => Promise<T | undefined>;
  /** The calling plugin's OWN app hook `name` on this machine, only when it is that hook's one provider. */
  readonly hook: (name: string) => unknown;
  /**
   * THIS plugin's own guarded client on that daemon (the one cache): the background-origin entry in a background
   * place, the ordinary entry everywhere else. The same object for the connection's life.
   */
  readonly client: PluginClient;
}

const NONE: readonly DaemonReach[] = Object.freeze([]);
const noSubscription = (): (() => void) => () => {};
const nothing = (): readonly DaemonReach[] => NONE;

const noReason = (): undefined => undefined;

/**
 * WHY THE CALLING PLUGIN HAS NO ROW ON A MACHINE (S2): a lookup `(daemon) => NoReach | undefined`, stable for the
 * caller's life and always reading the shell's present answer, for code that waits for a machine's row (a read of
 * another machine that is still connecting waits; one that is off or paused says the machine's own sentence). It
 * answers `undefined` for every machine outside a shell and on a daemon-less screen.
 */
export function useNoReach(): (daemon: string) => NoReach | undefined {
  return usePluginIdentity()?.reach?.whyNone ?? noReason;
}

/**
 * Every paired daemon where the calling plugin is on and allowed, in the daemon list's order; live. Answers in a
 * per-daemon view, a background view, a device panel or a device view; `[]` on a daemon-less screen and outside a
 * shell.
 */
export function useEveryDaemon(): readonly DaemonReach[] {
  const reach = usePluginIdentity()?.reach;
  const rows = reach?.rows ?? nothing;
  return useSyncExternalStore(reach?.subscribe ?? noSubscription, rows, rows);
}

interface Held {
  readonly row: DaemonReach;
  /** What the row was built from: a row is rebuilt only when one of these moved. */
  readonly facts: readonly unknown[];
}

interface Rows {
  readonly version: number;
  readonly rows: readonly DaemonReach[];
  readonly byDaemon: ReadonlyMap<string, Held>;
}

const sameFacts = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((fact, i) => fact === b[i]);

/**
 * The rows per (plugin, origin), read from the runtime at its version: the same array until a row changes, and the
 * same row object until its machine, feed, lock, client, inventory or grants answer moves.
 */
export class DaemonReachCache {
  readonly #runtime: ShellRuntime;
  readonly #reaches = new Map<string, PluginReach>();
  readonly #rows = new Map<string, Rows>();

  constructor(runtime: ShellRuntime) {
    this.#runtime = runtime;
  }

  reach(plugin: string, origin: ClientOrigin): PluginReach {
    const key = `${origin}\u0000${plugin}`;
    const known = this.#reaches.get(key);
    if (known !== undefined) return known;
    const reach: PluginReach = {
      subscribe: listener => this.#runtime.subscribe(listener),
      rows: () => this.#read(key, plugin, origin),
      whyNone: daemon => this.#whyNone(plugin, daemon),
    };
    this.#reaches.set(key, reach);
    return reach;
  }

  #whyNone(plugin: string, daemon: string): NoReach | undefined {
    const runtime = this.#runtime;
    if (runtime.daemons.get(daemon) === undefined)
      return { waiting: false, line: 'This device is not paired with that machine.' };
    const line = runtime.blockedLine(daemon, plugin);
    if (line === undefined) return undefined;
    const standing = runtime.standing(daemon, plugin);
    const waiting =
      runtime.connection(daemon).kind === 'unreachable' ||
      (standing.state !== 'allowed' && standing.reason === 'unread');
    return { waiting, line };
  }

  #read(key: string, plugin: string, origin: ClientOrigin): readonly DaemonReach[] {
    const runtime = this.#runtime;
    const version = runtime.version();
    const held = this.#rows.get(key);
    if (held?.version === version) return held.rows;
    const byDaemon = new Map<string, Held>();
    const rows: DaemonReach[] = [];
    for (const paired of runtime.daemons.snapshot().daemons) {
      const daemon = paired.daemon;
      const client = runtime.client(daemon, plugin, origin);
      if (client === undefined) continue;
      const machine = daemonTitle(paired);
      const online = runtime.online(daemon);
      const locked = runtime.isLocked(daemon);
      const facts = [client, machine, online, locked, ...runtime.stampOf(daemon)];
      const previous = held?.byDaemon.get(daemon);
      const row =
        previous !== undefined && sameFacts(previous.facts, facts)
          ? previous.row
          : this.#row(plugin, daemon, client, machine, online, locked);
      byDaemon.set(daemon, { row, facts });
      rows.push(row);
    }
    const unchanged =
      held !== undefined && rows.length === held.rows.length && rows.every((row, i) => row === held.rows[i]);
    const next = unchanged ? held.rows : Object.freeze(rows);
    this.#rows.set(key, { version, rows: next, byDaemon });
    return next;
  }

  #row(
    plugin: string,
    daemon: string,
    client: PluginClient,
    machine: string,
    online: boolean,
    locked: boolean,
  ): DaemonReach {
    const runtime = this.#runtime;
    return Object.freeze({
      daemon,
      machine,
      online,
      locked,
      authority: (capability: CapabilityName, axis: Axis) => runtime.authority(daemon, capability, axis),
      authorityOf: (route: string) => runtime.authorityOf(daemon, route),
      unlock: () => runtime.unlock(daemon),
      press: <T>(act: () => Promise<T>) => runtime.press(daemon, act),
      hook: (name: string) => {
        const providers = appHookProviders(runtime.surfaces, name);
        return providers.length === 1 && providers[0]?.plugin === plugin ? runtime.appHook(daemon, name) : undefined;
      },
      client,
    });
  }
}
