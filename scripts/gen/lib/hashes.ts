/**
 * Contract hashes (§9.6). The CANONICAL hash covers a package's own published surface: routes, sockets, member routes,
 * agent tools, events it publishes, hooks it offers, ask sources it registers, renderer keys, and the JSON schema of
 * every zod schema its contract exports (the bodies either side parses). The EFFECTIVE hash folds in the effective
 * hashes of every contract it consumes, transitively, so a change to Board's card payload changes Board's hash AND the
 * hash of every package that renders or calls it. Strongly connected consumers share one fold.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import type { StartGraph } from './graph.ts';
import type { ImportEdge } from './imports.ts';
import type { LoadedSubsystem, Workspace } from './workspace.ts';
import { contractPath } from './workspace.ts';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** RFC 8785-style canonical JSON: sorted keys, no whitespace. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { readonly [key: string]: Json };
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key] as Json)}`)
    .join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface ZodLike {
  readonly _zod?: unknown;
}

const isZod = (value: unknown): value is ZodLike =>
  typeof value === 'object' && value !== null && '_zod' in (value as object);

type ToJsonSchema = (schema: unknown, options: Record<string, unknown>) => unknown;

/** zod's `toJSONSchema`, from the copy the kernel resolves (the workspace uses Bun's isolated linker). */
export async function loadToJsonSchema(ws: Workspace): Promise<ToJsonSchema> {
  // A fixture workspace has no node_modules; the SDK's own kernel always resolves zod.
  const from = ws.byId('kernel')?.dir ?? join(import.meta.dir, '..', '..', '..', 'packages', 'core', 'kernel');
  const zodPath = Bun.resolveSync('zod', from);
  const zod = (await import(zodPath)) as { z?: { toJSONSchema: ToJsonSchema }; toJSONSchema?: ToJsonSchema };
  const fn = zod.toJSONSchema ?? zod.z?.toJSONSchema;
  if (fn === undefined) throw new Error(`zod at ${zodPath} has no toJSONSchema`);
  return fn;
}

/** Turns declaration data (descriptors, schemas, tokens) into stable JSON. Functions become `true`. */
export function toStableJson(value: unknown, toJsonSchema: ToJsonSchema, depth = 0): Json {
  if (depth > 12) return '…';
  if (value === null || value === undefined) return null;
  if (typeof value === 'function') return true;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (isZod(value)) {
    try {
      return toStableJson(toJsonSchema(value, { unrepresentable: 'any', io: 'input' }), toJsonSchema, depth + 1);
    } catch {
      return { unrepresentable: true };
    }
  }
  if (Array.isArray(value)) return value.map(item => toStableJson(item, toJsonSchema, depth + 1));
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || key.startsWith('__')) continue;
    out[key] = toStableJson(item, toJsonSchema, depth + 1);
  }
  return out;
}

/** The published surface of one package, as stable JSON (the canonical hash input). */
export async function surfaceOf(
  _ws: Workspace,
  subsystem: LoadedSubsystem,
  toJsonSchema: ToJsonSchema,
): Promise<Json> {
  const m: Manifest = subsystem.manifest;
  const stable = (value: unknown): Json => toStableJson(value, toJsonSchema);
  const contractFile = contractPath(subsystem.pkg);
  const schemas: Record<string, Json> = {};
  if (contractFile !== undefined) {
    const module = (await import(contractFile)) as Record<string, unknown>;
    for (const name of Object.keys(module).sort()) {
      const value = module[name];
      if (isZod(value)) schemas[name] = stable(value);
      else if (typeof value === 'object' && value !== null && 'kind' in value) {
        const kind = (value as { kind: unknown }).kind;
        if (kind === 'event' || kind === 'hook' || kind === 'port') schemas[name] = stable(value);
      }
    }
  }
  return {
    id: m.id,
    api: m.api,
    routes: stable(m.actions?.routes ?? []),
    sockets: stable(m.actions?.sockets ?? []),
    memberRoutes: stable(m.actions?.memberRoutes ?? []),
    tools: stable(m.actions?.agentTools ?? []),
    publishes: stable(m.data?.publishes ?? []),
    offers: stable((m.hooks?.offers ?? []).map(offer => offer.hook)),
    askSources: stable(
      (m.hooks?.takes ?? [])
        .filter(take => take.hook.name === 'ask.sources')
        .map(take => ({ key: take.key ?? null, schema: take.schema ?? null })),
    ),
    renderers: stable((m.ui?.renderers ?? []).map(entry => entry.key)),
    contract: schemas,
  };
}

/**
 * Which packages each package consumes (§9.6): providers of its needs and uses, offerers of hooks it takes, the
 * registrar of each ask source it renders, and every contract its own files import.
 */
export function consumedBy(
  graph: StartGraph,
  edges: readonly ImportEdge[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const consumed = new Map<string, Set<string>>(graph.ids.map(id => [id, new Set<string>()]));
  const askRegistrar = new Map<string, string>();
  for (const id of graph.ids)
    for (const take of graph.manifests.get(id)?.hooks?.takes ?? [])
      if (take.hook.name === 'ask.sources' && take.key !== undefined) askRegistrar.set(take.key, id);
  for (const id of graph.ids) {
    const m = graph.manifests.get(id) as Manifest;
    const add = (other: string | undefined): void => {
      if (other !== undefined && other !== id && graph.manifests.has(other)) consumed.get(id)?.add(other);
    };
    for (const token of [...Object.values(m.needs ?? {}), ...Object.values(m.uses ?? {})])
      for (const provider of graph.providers.get(token.name) ?? []) add(provider);
    for (const take of m.hooks?.takes ?? []) for (const offerer of graph.offerers.get(take.hook.name) ?? []) add(offerer);
    for (const entry of m.ui?.renderers ?? []) if (entry.kind === 'ask') add(askRegistrar.get(entry.source));
  }
  for (const edge of edges) {
    const from = edge.fromPkg.id;
    const to = edge.toPkg?.id;
    if (from === undefined || to === undefined || edge.fromArea === 'tests') continue;
    if (edge.toArea === 'contract' || edge.toArea === 'kernel-contract') consumed.get(from)?.add(to);
  }
  for (const [id, set] of consumed) set.delete(id);
  return consumed;
}

export interface ContractHashes {
  readonly canonical: string;
  readonly effective: string;
}

/** Folds canonical hashes into effective ones over the consumption graph (Tarjan SCCs, deterministic). */
export function effectiveHashes(
  canonical: ReadonlyMap<string, string>,
  consumed: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ContractHashes> {
  const ids = [...canonical.keys()].sort();
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccOf = new Map<string, number>();
  const sccs: string[][] = [];
  const strong = (id: string): void => {
    indices.set(id, index);
    low.set(id, index);
    index++;
    stack.push(id);
    onStack.add(id);
    for (const next of [...(consumed.get(id) ?? [])].sort()) {
      if (!canonical.has(next)) continue;
      if (!indices.has(next)) {
        strong(next);
        low.set(id, Math.min(low.get(id) as number, low.get(next) as number));
      } else if (onStack.has(next)) low.set(id, Math.min(low.get(id) as number, indices.get(next) as number));
    }
    if (low.get(id) === indices.get(id)) {
      const scc: string[] = [];
      for (;;) {
        const top = stack.pop() as string;
        onStack.delete(top);
        sccOf.set(top, sccs.length);
        scc.push(top);
        if (top === id) break;
      }
      sccs.push(scc.sort());
    }
  };
  for (const id of ids) if (!indices.has(id)) strong(id);
  // Tarjan emits SCCs in reverse topological order: every dependency's SCC is finished first.
  const sccHash: string[] = [];
  sccs.forEach((members, at) => {
    const external = new Set<string>();
    for (const member of members)
      for (const dep of consumed.get(member) ?? []) {
        const depScc = sccOf.get(dep);
        if (depScc !== undefined && depScc !== at) external.add(`${dep}=${sccHash[depScc]}`);
      }
    const own = members.map(member => `${member}=${canonical.get(member)}`);
    sccHash[at] = sha256([...own, '|', ...[...external].sort()].join('\n'));
  });
  const result = new Map<string, ContractHashes>();
  for (const id of ids) {
    const own = canonical.get(id) as string;
    result.set(id, { canonical: own, effective: sha256(`${own}\n${sccHash[sccOf.get(id) as number]}`) });
  }
  return result;
}

/** The release hash compare (§9.6): which packages' effective hashes changed between two `contract-hashes.json`. */
export function compareHashes(
  previous: Readonly<Record<string, ContractHashes>>,
  next: Readonly<Record<string, ContractHashes>>,
): { readonly changed: string[]; readonly added: string[]; readonly removed: string[] } {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of Object.keys(next).sort()) {
    const before = previous[id];
    if (before === undefined) added.push(id);
    else if (before.effective !== next[id]?.effective) changed.push(id);
  }
  for (const id of Object.keys(previous).sort()) if (next[id] === undefined) removed.push(id);
  return { changed, added, removed };
}
