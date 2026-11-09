/**
 * The start-order graph (§2.4, §3.5, §7.6) read from manifests alone: who provides each port, who offers each hook,
 * the edges `needs` and taken hooks make, the order they give, and every way the graph can be wrong
 * (`plugin-graph`, `core-closed`). Pure over loaded manifests; no subsystem is named.
 */
import { CORE_IDS, KERNEL_BOUND_PORTS, KERNEL_ONLY_PORTS } from '../../../packages/core/kernel/contract/index.ts';
import type { HookDef, PortToken } from '../../../packages/core/kernel/contract/index.ts';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import type { LoadedSubsystem } from './workspace.ts';

const CORE = new Set<string>(CORE_IDS);
export const isCore = (id: string): boolean => CORE.has(id);

export interface Finding {
  readonly check: string;
  readonly where: string;
  readonly message: string;
}

export interface StartGraph {
  readonly ids: readonly string[];
  readonly manifests: ReadonlyMap<string, Manifest>;
  /** port name → providing subsystem ids */
  readonly providers: ReadonlyMap<string, readonly string[]>;
  /** hook name → offering subsystem ids */
  readonly offerers: ReadonlyMap<string, readonly string[]>;
  /** hook name → the definition as the first offerer declared it */
  readonly hooks: ReadonlyMap<string, HookDef>;
  /** id → ids that must be built before it */
  readonly before: ReadonlyMap<string, ReadonlySet<string>>;
  /** Start order (deterministic: kernel, then core in CORE_IDS order, then by id), or undefined on a cycle. */
  readonly order: readonly string[] | undefined;
  /** One cycle, when there is one. */
  readonly cycle: readonly string[] | undefined;
}

function tokens(record: Readonly<Record<string, PortToken<unknown>>> | undefined): PortToken<unknown>[] {
  return Object.values(record ?? {});
}

function rank(id: string): number {
  const index = (CORE_IDS as readonly string[]).indexOf(id);
  return index === -1 ? CORE_IDS.length : index;
}

const byRankThenId = (a: string, b: string): number => rank(a) - rank(b) || a.localeCompare(b);

export function buildGraph(subsystems: readonly LoadedSubsystem[]): StartGraph {
  const manifests = new Map(subsystems.map(s => [s.id, s.manifest] as const));
  const ids = [...manifests.keys()].sort(byRankThenId);
  const providers = new Map<string, string[]>();
  const offerers = new Map<string, string[]>();
  const hooks = new Map<string, HookDef>();
  for (const id of ids) {
    const manifest = manifests.get(id) as Manifest;
    for (const token of tokens(manifest.provides))
      providers.set(token.name, [...(providers.get(token.name) ?? []), id]);
    for (const offer of manifest.hooks?.offers ?? []) {
      offerers.set(offer.hook.name, [...(offerers.get(offer.hook.name) ?? []), id]);
      if (!hooks.has(offer.hook.name)) hooks.set(offer.hook.name, offer.hook);
    }
  }
  const before = new Map<string, Set<string>>(ids.map(id => [id, new Set<string>()]));
  const edge = (first: string, then: string): void => {
    if (first !== then && manifests.has(first) && manifests.has(then)) before.get(then)?.add(first);
  };
  for (const id of ids) {
    const manifest = manifests.get(id) as Manifest;
    for (const token of tokens(manifest.needs))
      for (const provider of providers.get(token.name) ?? []) edge(provider, id);
    for (const take of manifest.hooks?.takes ?? [])
      for (const offerer of offerers.get(take.hook.name) ?? []) edge(offerer, id);
    for (const after of manifest.order?.after ?? []) edge(after, id);
    for (const beforeId of manifest.order?.before ?? []) edge(id, beforeId);
  }
  // Kahn, choosing the lowest-ranked ready node each step.
  const remaining = new Map([...before].map(([id, set]) => [id, new Set(set)] as const));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, set]) => set.size === 0).map(([id]) => id);
    if (ready.length === 0) break;
    const next = ready.sort(byRankThenId)[0] as string;
    order.push(next);
    remaining.delete(next);
    for (const set of remaining.values()) set.delete(next);
  }
  const cycle = remaining.size === 0 ? undefined : findCycle(remaining);
  return {
    ids,
    manifests,
    providers,
    offerers,
    hooks,
    before,
    order: cycle === undefined ? order : undefined,
    cycle,
  };
}

function findCycle(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  let found: string[] = [];
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      found = [...stack.slice(stack.indexOf(id)), id];
      return true;
    }
    if (done.has(id)) return false;
    visiting.add(id);
    stack.push(id);
    for (const dep of [...(graph.get(id) ?? [])].sort()) if (graph.has(dep) && visit(dep)) return true;
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const id of [...graph.keys()].sort()) if (visit(id)) break;
  return found;
}

/** The plugin whose `item` manifest declares the config collection named for this item kind, if any (the kernel's rule). */
function configItemOwner(graph: StartGraph, kind: string): string | undefined {
  return graph.ids.find(owner => {
    const manifest = graph.manifests.get(owner) as Manifest;
    return (
      manifest.kinds.includes('item') &&
      (manifest.data?.config ?? []).some(def => def.shape === 'collection' && def.collection === kind)
    );
  });
}

/** `plugin-graph` (§7.9): cycles, missing providers, kernel-bound port providers, security-path takers, key clashes. */
export function pluginGraphFindings(graph: StartGraph): Finding[] {
  const check = 'plugin-graph';
  const findings: Finding[] = [];
  if (graph.cycle !== undefined)
    findings.push({ check, where: graph.cycle[0] ?? '?', message: `start-order cycle: ${graph.cycle.join(' → ')}` });
  for (const id of graph.ids) {
    const manifest = graph.manifests.get(id) as Manifest;
    for (const [field, token] of Object.entries(manifest.needs ?? {}))
      if ((graph.providers.get(token.name) ?? []).length === 0)
        findings.push({ check, where: id, message: `needs ${field} (port "${token.name}") but nothing provides it` });
    for (const take of manifest.hooks?.takes ?? []) {
      const offeredBy = graph.offerers.get(take.hook.name) ?? [];
      if (offeredBy.length === 0)
        findings.push({ check, where: id, message: `takes hook "${take.hook.name}" that nothing offers` });
      const hook = take.hook;
      if (hook.mode === 'decide' && hook.securityPath && !isCore(id))
        findings.push({ check, where: id, message: `takes security-path hook "${hook.name}"; only core may` });
      if (hook.mode === 'provide') {
        if (take.key === undefined)
          findings.push({ check, where: id, message: `takes provide hook "${hook.name}" without a key` });
        if (hook.takers !== undefined && !hook.takers.includes(id))
          findings.push({
            check,
            where: id,
            message: `takes security-path hook "${hook.name}"; its takers are ${hook.takers.join(', ') || 'none'}`,
          });
      }
    }
    for (const offer of manifest.hooks?.offers ?? [])
      if (offer.hook.mode === 'decide' && offer.hook.securityPath && !isCore(id))
        findings.push({ check, where: id, message: `offers security-path hook "${offer.hook.name}"; only core may` });
    // A port only the kernel binds (the ChildEnvironment opener) is never a half's need or use (lead decision 8).
    for (const token of [...Object.values(manifest.needs ?? {}), ...Object.values(manifest.uses ?? {})])
      if (KERNEL_ONLY_PORTS.includes(token.name))
        findings.push({ check, where: id, message: `asks for "${token.name}", which only the kernel may hold` });
    // A wildcard reach (Vault's `${secret}` run of an owner command, its authorized fetch) is core's alone.
    if (manifest.core !== true)
      for (const field of ['spawn', 'network'] as const)
        if ((manifest.permissions?.[field] ?? []).some(entry => entry === '*'))
          findings.push({ check, where: id, message: `declares permissions.${field} '*'; only a core piece may` });
    // `{ items: kind }` for a kind whose items live in one plugin's config collection counts THAT owner's items live:
    // naming another plugin's items is the owner's act to grant, so only the owner may declare it.
    for (const field of ['spawn', 'network'] as const)
      for (const entry of manifest.permissions?.[field] ?? []) {
        if (typeof entry !== 'object' || !('items' in entry)) continue;
        const owner = configItemOwner(graph, entry.items);
        if (owner !== undefined && owner !== id)
          findings.push({
            check,
            where: id,
            message: `declares permissions.${field} { items: '${entry.items}' }, whose items are ${owner}'s config collection; only ${owner} may`,
          });
      }
    for (const token of Object.values(manifest.provides ?? {}))
      if (token.boundBy !== undefined && token.boundBy !== id)
        findings.push({
          check,
          where: id,
          message: `provides kernel-bound port "${token.name}"; only ${token.boundBy} may`,
        });
  }
  const keyTakers = new Map<string, string[]>();
  for (const id of graph.ids)
    for (const take of graph.manifests.get(id)?.hooks?.takes ?? [])
      if (take.hook.mode === 'provide' && take.key !== undefined) {
        const slot = `${take.hook.name}:${take.key}`;
        keyTakers.set(slot, [...(keyTakers.get(slot) ?? []), id]);
      }
  for (const [slot, takers] of keyTakers)
    if (takers.length > 1)
      findings.push({ check, where: takers.join(', '), message: `two takers of provide key ${slot}` });
  for (const port of KERNEL_BOUND_PORTS) {
    const count = (graph.providers.get(port.name) ?? []).length;
    if (count !== 1)
      findings.push({
        check,
        where: port.boundBy ?? 'kernel',
        message: `kernel-bound port "${port.name}" has ${count} providers; it needs exactly one (${port.boundBy})`,
      });
  }
  for (const [port, ids] of graph.providers)
    if (ids.length > 1 && !KERNEL_BOUND_PORTS.some(bound => bound.name === port))
      findings.push({ check, where: ids.join(', '), message: `port "${port}" has ${ids.length} providers` });
  return findings;
}

/** `core-closed` (§7.9): a core manifest needs, uses or takes a hook from a plugin. */
export function coreClosedFindings(graph: StartGraph): Finding[] {
  const check = 'core-closed';
  const findings: Finding[] = [];
  for (const id of graph.ids.filter(isCore)) {
    const manifest = graph.manifests.get(id) as Manifest;
    for (const [section, record] of [
      ['needs', manifest.needs],
      ['uses', manifest.uses],
    ] as const)
      for (const token of tokens(record))
        for (const provider of graph.providers.get(token.name) ?? [])
          if (!isCore(provider))
            findings.push({ check, where: id, message: `${section} "${token.name}", provided by plugin ${provider}` });
    for (const take of manifest.hooks?.takes ?? [])
      for (const offerer of graph.offerers.get(take.hook.name) ?? [])
        if (!isCore(offerer))
          findings.push({ check, where: id, message: `takes hook "${take.hook.name}", offered by plugin ${offerer}` });
  }
  return findings;
}

/** Takers of each offered hook in invocation order: priority high first, then start order, then id (§3.5). */
export function hookOrder(graph: StartGraph): ReadonlyMap<string, readonly { id: string; key?: string }[]> {
  const position = new Map((graph.order ?? graph.ids).map((id, index) => [id, index] as const));
  const result = new Map<string, { id: string; key?: string; priority: number }[]>();
  for (const id of graph.ids) {
    const manifest = graph.manifests.get(id) as Manifest;
    for (const take of manifest.hooks?.takes ?? []) {
      const list = result.get(take.hook.name) ?? [];
      list.push({
        id,
        ...(take.key === undefined ? {} : { key: take.key }),
        priority: take.priority ?? manifest.priority ?? 50,
      });
      result.set(take.hook.name, list);
    }
  }
  for (const list of result.values())
    list.sort(
      (a, b) =>
        b.priority - a.priority || (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0) || a.id.localeCompare(b.id),
    );
  return result;
}
