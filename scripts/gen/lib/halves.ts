/**
 * What a half implements, read by running its synchronous `build` against an inert context (`manifest-match`, §7.9).
 * A build is pure set-up (§7.6 step 4), so every port it touches here is a recording no-op. A half that throws while
 * being inspected is reported, never assumed to match.
 */
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import type { Finding } from './graph.ts';
import type { AnyImplementation, HalfName } from './workspace.ts';

/** Every name a half must implement, per section, from its manifest. */
export function expectedSections(manifest: Manifest, half: HalfName): Record<string, readonly string[]> {
  if (half === 'daemon')
    return {
      routes: (manifest.actions?.routes ?? []).map(r => r.key),
      sockets: (manifest.actions?.sockets ?? []).map(s => s.key),
      memberRoutes: (manifest.actions?.memberRoutes ?? []).map(r => r.key),
      tools: (manifest.actions?.agentTools ?? []).map(t => t.name),
      provides: Object.keys(manifest.provides ?? {}),
      hooks: (manifest.hooks?.takes ?? []).map(take =>
        take.hook.mode === 'provide' && take.key !== undefined ? `${take.hook.name}:${take.key}` : take.hook.name,
      ),
      subscribers: (manifest.data?.subscribes ?? []).map(event => event.name),
      doctor: [...(manifest.doctor ?? [])],
      resolvers: [
        ...new Set(
          [...(manifest.permissions?.network ?? []), ...(manifest.permissions?.spawn ?? [])].flatMap(entry =>
            typeof entry === 'object' && 'resolver' in entry ? [entry.resolver] : [],
          ),
        ),
      ],
    };
  if (half === 'app')
    return {
      screens: (manifest.ui?.screens ?? []).map(s => s.id),
      panels: (manifest.ui?.panels ?? []).map(p => p.id),
      settings: (manifest.ui?.settings ?? []).map(s => s.id),
      renderers: (manifest.ui?.renderers ?? []).map(r => r.key),
    };
  // A data-plugin alias verb is run by the shell, never implemented by a half.
  return { verbs: (manifest.actions?.cli ?? []).filter(v => v.alias === undefined).map(v => v.verb) };
}

/** An inert stand-in for every context field: any property, any call, never a thenable. */
function inert(): unknown {
  const target = function inertFunction(): void {};
  const proxy: unknown = new Proxy(target, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => '';
      if (property === Symbol.iterator) return function* empty(): Generator<never> {};
      return proxy;
    },
    apply() {
      return proxy;
    },
    construct() {
      return proxy as object;
    },
  });
  return proxy;
}

/** Runs `build` against an inert context and returns the keys of each section it returned. */
export function implementedSections(
  impl: AnyImplementation,
): { readonly sections: Record<string, readonly string[]> } | { readonly error: string } {
  const build = (impl as { build?: (ctx: unknown) => unknown }).build;
  if (build === undefined) return { sections: {} };
  try {
    const ctx = {
      manifest: impl.manifest,
      needs: inert(),
      uses: inert(),
      kernel: inert(),
      hooks: inert(),
      client: inert(),
      io: inert(),
    };
    const half = build(ctx) as Record<string, unknown> | undefined;
    if (half === undefined || half === null || typeof half !== 'object') return { error: 'build returned no object' };
    const sections: Record<string, readonly string[]> = {};
    for (const [section, value] of Object.entries(half))
      sections[section] = value !== null && typeof value === 'object' ? Object.keys(value as object) : [];
    return { sections };
  } catch (error) {
    return { error: `build threw while inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function isSkeleton(impl: AnyImplementation): boolean {
  return (impl as { skeleton?: true }).skeleton === true;
}

/** Compares one half with its manifest. `pending` = the id is in ports-pending.json. */
/**
 * Sections whose declared names may be left unimplemented: a declared doctor check with no run is reported by
 * `fy doctor` itself as a failure naming the check, so the half still builds (an undeclared run is still refused).
 */
const MAY_BE_UNIMPLEMENTED: ReadonlySet<string> = new Set(['doctor']);

/**
 * Members of a daemon half that are a function, not a section of named entries: the host calls `beforeListen` once
 * per boot (the boot sweep Access runs), so it is neither declared by the manifest nor a section to compare.
 */
const HOST_CALLED_MEMBERS: ReadonlySet<string> = new Set(['beforeListen']);

export function halfFindings(
  where: string,
  manifest: Manifest,
  half: HalfName,
  impl: AnyImplementation | undefined,
  pending: boolean,
): Finding[] {
  const check = 'manifest-match';
  if (impl === undefined) return [{ check, where, message: `${half} half has no default export` }];
  const findings: Finding[] = [];
  if (impl.half !== half) findings.push({ check, where, message: `${half} entry exports a ${impl.half} half` });
  if (impl.manifest !== manifest && impl.manifest?.id !== manifest.id)
    findings.push({ check, where, message: `${half} half is built from another manifest (${impl.manifest?.id})` });
  if (isSkeleton(impl)) {
    if (!pending)
      findings.push({
        check,
        where,
        message: `${half} half is a skeleton but ${manifest.id} is not in ports-pending.json`,
      });
    return findings;
  }
  const inspected = implementedSections(impl);
  if ('error' in inspected) return [...findings, { check, where, message: `${half} half: ${inspected.error}` }];
  const expected = expectedSections(manifest, half);
  for (const [section, names] of Object.entries(expected)) {
    if (MAY_BE_UNIMPLEMENTED.has(section)) continue;
    const have = new Set(inspected.sections[section] ?? []);
    for (const name of names)
      if (!have.has(name)) findings.push({ check, where, message: `${half} half misses ${section} "${name}"` });
  }
  for (const [section, names] of Object.entries(inspected.sections)) {
    if (half === 'daemon' && HOST_CALLED_MEMBERS.has(section)) continue;
    const declared = new Set(expected[section] ?? []);
    if (!(section in expected)) {
      findings.push({ check, where, message: `${half} half returns unknown section "${section}"` });
      continue;
    }
    for (const name of names)
      if (!declared.has(name))
        findings.push({ check, where, message: `${half} half implements undeclared ${section} "${name}"` });
  }
  if (half === 'daemon') findings.push(...checkSeamFindings(where, manifest, impl));
  return findings;
}

/**
 * The `fyd --check` seams sit beside `build` on the implementation, not in its result: every declared id needs an
 * implementation and every implementation a declared id, exactly as a doctor check or a route does.
 */
function checkSeamFindings(where: string, manifest: Manifest, impl: AnyImplementation): Finding[] {
  const check = 'manifest-match';
  const findings: Finding[] = [];
  const seams = impl as { preflight?: object; selftest?: object; workers?: object };
  for (const seam of ['preflight', 'selftest', 'workers'] as const) {
    const declared = new Set(manifest[seam] ?? []);
    const have = new Set(Object.keys(seams[seam] ?? {}));
    for (const id of declared)
      if (!have.has(id)) findings.push({ check, where, message: `daemon half misses ${seam} "${id}"` });
    for (const id of have)
      if (!declared.has(id))
        findings.push({ check, where, message: `daemon half implements undeclared ${seam} "${id}"` });
  }
  // A selftest's `enabledBy` names one of the manifest's OWN config file defs (kernel batch #14): the very object.
  const own: readonly unknown[] = manifest.data?.config ?? [];
  for (const [id, probe] of Object.entries(
    (seams.selftest ?? {}) as Record<string, { enabledBy?: { def?: unknown } }>,
  )) {
    const def = probe?.enabledBy?.def as { shape?: unknown } | undefined;
    if (probe?.enabledBy !== undefined && (def?.shape !== 'file' || !own.includes(def)))
      findings.push({
        check,
        where,
        message: `daemon half's selftest "${id}" is switched by a config file that is not one of its own declared files`,
      });
  }
  return findings;
}
