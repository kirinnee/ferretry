import type { PortToken } from '../contract/define.ts';
import { KERNEL_ONLY_PORTS } from '../contract/bound.ts';
import { CORE_IDS } from '../contract/ids.ts';
import { reachFaults } from '../manifest/reach.ts';
import type { Manifest } from '../manifest/types.ts';

/** Why a plugin is not started (§3.4 checked/resolved, §2.4). Each is a plain sentence for `fy doctor`. */
export interface GraphRefusal {
  readonly plugin: string;
  readonly reason:
    | 'off'
    | 'missing-provider'
    | 'cycle'
    | 'bound-port'
    | 'duplicate'
    | 'needs-refused'
    | 'hook'
    | 'kernel-only-port'
    | 'kernel-event'
    | 'reach';
  readonly sentence: string;
}

export interface GraphPlan {
  /** Enabled, resolved plugins in start order (needs and taken hooks first). */
  readonly order: readonly Manifest[];
  readonly refused: readonly GraphRefusal[];
  /** Port name → providing plugin, over the started set. */
  readonly providers: ReadonlyMap<string, string>;
}

const isCore = (id: string): boolean => (CORE_IDS as readonly string[]).includes(id);
/** Kernel first, then core, then plugins: the tie-break of the start order (§7.6). */
const rank = (id: string): number => (id === 'kernel' ? 0 : isCore(id) ? 1 : 2);

const tokens = (record: Readonly<Record<string, PortToken<unknown>>> | undefined): readonly PortToken<unknown>[] =>
  Object.values(record ?? {});

/**
 * Checks the enabled graph (§7.6 step 1), the same checks as CI's `plugin-graph`: a required provider is missing,
 * a cycle in needs plus taken hooks, a kernel-bound port with zero or two providers or a non-core provider. A plugin
 * that fails is not started, and its dependents follow; the rest boots. `extraEdges` carries the hook edges (taker →
 * offerer) the hooks engine resolved.
 */
export function planGraph(
  manifests: readonly Manifest[],
  enabled: (id: string) => boolean,
  hookEdges: (manifest: Manifest) => readonly string[],
): GraphPlan {
  const refused = new Map<string, GraphRefusal>();
  const refuse = (refusal: GraphRefusal): void => {
    if (!refused.has(refusal.plugin)) refused.set(refusal.plugin, refusal);
  };
  const byId = new Map<string, Manifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) {
      refuse({ plugin: manifest.id, reason: 'duplicate', sentence: `Two packages call themselves ${manifest.id}.` });
      continue;
    }
    byId.set(manifest.id, manifest);
  }
  for (const manifest of byId.values())
    if (!isCore(manifest.id) && !enabled(manifest.id))
      refuse({ plugin: manifest.id, reason: 'off', sentence: `${manifest.title} is turned off.` });

  // Providers: one per port; kernel-bound ports only by their named core piece.
  const providers = new Map<string, string>();
  for (const manifest of byId.values()) {
    if (refused.has(manifest.id)) continue;
    for (const token of tokens(manifest.provides)) {
      if (token.boundBy !== undefined && token.boundBy !== manifest.id) {
        refuse({
          plugin: manifest.id,
          reason: 'bound-port',
          sentence: `${manifest.id} provides ${token.name}, which only ${token.boundBy} may provide.`,
        });
        continue;
      }
      const other = providers.get(token.name);
      if (other !== undefined) {
        refuse({
          plugin: manifest.id,
          reason: 'duplicate',
          sentence: `${other} and ${manifest.id} both provide ${token.name}.`,
        });
        continue;
      }
      providers.set(token.name, manifest.id);
    }
  }

  // A port only the kernel may hold (the ChildEnvironment opener) reaches no half, through needs or uses.
  for (const manifest of byId.values()) {
    if (refused.has(manifest.id)) continue;
    const asked = [...tokens(manifest.needs), ...tokens(manifest.uses)].find(token =>
      KERNEL_ONLY_PORTS.includes(token.name),
    );
    if (asked !== undefined)
      refuse({
        plugin: manifest.id,
        reason: 'kernel-only-port',
        sentence: `${manifest.title} asks for ${asked.name}, which only the kernel may hold.`,
      });
  }

  // A `kernel.*` event is the kernel's own: a plugin that declares one would forge it and move its discovery gate.
  for (const manifest of byId.values()) {
    if (refused.has(manifest.id) || manifest.id === 'kernel') continue;
    const claimed = (manifest.data?.publishes ?? []).find(event => event.name.startsWith('kernel.'));
    if (claimed !== undefined)
      refuse({
        plugin: manifest.id,
        reason: 'kernel-event',
        sentence: `${manifest.title} publishes ${claimed.name}, which only the kernel may publish.`,
      });
  }

  // Reach the kernel does not honour (K1, K2): `{ items }` of a kind someone else owns, one resolver on both axes. The
  // same rule as CI's `plugin-graph`, so a plugin built outside that check is refused here, and so is the testing host.
  for (const fault of reachFaults([...byId.values()])) {
    const manifest = byId.get(fault.plugin);
    if (manifest === undefined || refused.has(manifest.id)) continue;
    refuse({ plugin: manifest.id, reason: 'reach', sentence: `${manifest.title} ${fault.sentence}.` });
  }

  // Required providers, transitively: a plugin whose need is refused is refused too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const manifest of byId.values()) {
      if (refused.has(manifest.id)) continue;
      for (const token of tokens(manifest.needs)) {
        const provider = providers.get(token.name);
        if (provider === undefined || refused.has(provider)) {
          refuse({
            plugin: manifest.id,
            reason: provider === undefined ? 'missing-provider' : 'needs-refused',
            sentence:
              provider === undefined
                ? `${manifest.title} needs ${token.name}, which nothing here provides.`
                : `${manifest.title} needs ${byId.get(provider)?.title ?? provider}, which is not running.`,
          });
          changed = true;
          break;
        }
      }
    }
  }

  // Start order: Kahn over needs + taken-hook edges, ties by id (deterministic). What is left is a cycle.
  const live = [...byId.values()].filter(manifest => !refused.has(manifest.id));
  const liveIds = new Set(live.map(manifest => manifest.id));
  const before = new Map<string, Set<string>>();
  for (const manifest of live) {
    const deps = new Set<string>();
    for (const token of tokens(manifest.needs)) {
      const provider = providers.get(token.name);
      if (provider !== undefined && provider !== manifest.id) deps.add(provider);
    }
    for (const offerer of hookEdges(manifest)) if (offerer !== manifest.id && liveIds.has(offerer)) deps.add(offerer);
    for (const after of manifest.order?.after ?? []) if (liveIds.has(after)) deps.add(after);
    before.set(manifest.id, deps);
  }
  for (const manifest of live) for (const later of manifest.order?.before ?? []) before.get(later)?.add(manifest.id);
  const order: Manifest[] = [];
  const done = new Set<string>();
  while (order.length < live.length) {
    const ready = live
      .filter(manifest => !done.has(manifest.id) && [...(before.get(manifest.id) ?? [])].every(dep => done.has(dep)))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    const next = ready[0];
    if (next === undefined) break;
    order.push(next);
    done.add(next.id);
  }
  for (const manifest of live)
    if (!done.has(manifest.id))
      refuse({
        plugin: manifest.id,
        reason: 'cycle',
        sentence: `${manifest.title} is in a start-order cycle (${[...(before.get(manifest.id) ?? [])].filter(dep => !done.has(dep)).join(', ')}).`,
      });
  const started = new Map([...providers].filter(([, plugin]) => done.has(plugin)));
  return { order, refused: [...refused.values()], providers: started };
}

/** Every plugin that (transitively) needs `id`: what turning it off or its failure takes with it (§2.4). */
export function dependentsOf(id: string, order: readonly Manifest[], providers: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>([id]);
  for (const manifest of order)
    for (const token of tokens(manifest.needs)) if (out.has(providers.get(token.name) ?? '')) out.add(manifest.id);
  out.delete(id);
  return [...out];
}
