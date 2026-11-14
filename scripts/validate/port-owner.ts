/**
 * `port-owner` (§2.3): a port NAME has one owner, and everyone who `uses` or `needs` it imports the owner's token.
 *
 * Ports are matched by name, so a plugin that declares its own `definePort<Narrow>('usage')` beside the real
 * Usage contract's `definePort<UsageApi>('usage')` type-checks, composes and then calls members the provider does not
 * have: the call throws at runtime (a 500) and nothing flags it. Packs did exactly that with `logins()` and
 * `paneLimits()`, and Warden carried the same stand-in. Two findings:
 *
 *   1. a contract file declares a port under a name another package's contract also declares;
 *   2. the manifests of the workspace name one port with more than one token (a `uses` binding that is not the
 *      provider's own contract export).
 *
 * The one declaration that is the owner's stays; the other imports `@ferretry/plugin-<owner>/contract` and, when it
 * wants a narrower view, takes `Pick<OwnerApi, 'member'>` of the owner's real type.
 */
import { readFileSync } from 'node:fs';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { areaOf } from '../gen/lib/imports.ts';
import { sourceFiles } from '../gen/lib/workspace.ts';

/**
 * A stand-in that exists on this base and is fixed on another branch: `package` declares `port` itself, and the entry goes
 * the moment that branch is composed (a stale entry is itself a finding, so it cannot outlive the fix).
 */
const KNOWN_STAND_INS: readonly { readonly package: string; readonly port: string; readonly fixedOn: string }[] = [
  { package: 'packs', port: 'usage', fixedOn: 'rebuild/packs-recommend (cc66939a11)' },
];
const known = (pkg: string | undefined, port: string): boolean =>
  KNOWN_STAND_INS.some(entry => entry.package === pkg && entry.port === port);

/** `definePort<Api>('name')`, whatever the generic holds. */
const DEFINE_PORT = /definePort\s*<[\s\S]*?>\s*\(\s*['"]([^'"]+)['"]/g;

/** The port names a source text declares, with the line each is declared on. */
export function declaredPorts(source: string): readonly { readonly name: string; readonly line: number }[] {
  return [...source.matchAll(DEFINE_PORT)].map(match => ({
    name: match[1] as string,
    line: source.slice(0, match.index).split('\n').length,
  }));
}

export const check: Check = {
  name: 'port-owner',
  summary: 'one contract declares each port name, and every uses/needs binding is the owner’s own token',
  async run(ctx) {
    const check = 'port-owner';
    const model = await ctx.model();
    const findings: Finding[] = [];

    // 1. Declarations: every `definePort` in a contract half, by name.
    const standIns = new Set<string>();
    const declared = new Map<string, { readonly pkg: string; readonly where: string }[]>();
    for (const s of model.ws.packages) {
      for (const file of sourceFiles(s, { tests: false })) {
        if (areaOf(s, file) !== 'contract' && areaOf(s, file) !== 'kernel-contract') continue;
        const rel = file.slice(model.ws.root.length + 1);
        for (const port of declaredPorts(readFileSync(file, 'utf8')))
          if (known(s.id, port.name)) standIns.add(`${s.id}:${port.name}`);
          else
            declared.set(port.name, [
              ...(declared.get(port.name) ?? []),
              { pkg: s.id ?? s.name, where: `${rel}:${port.line}` },
            ]);
      }
    }
    for (const entry of KNOWN_STAND_INS)
      if (model.ws.packages.some(pkg => pkg.id === entry.package) && !standIns.has(`${entry.package}:${entry.port}`))
        findings.push({
          check,
          where: entry.package,
          message: `no longer declares port "${entry.port}" (fixed on ${entry.fixedOn}): remove it from KNOWN_STAND_INS`,
        });
    for (const [name, sites] of declared) {
      const owners = new Set(sites.map(site => site.pkg));
      if (owners.size < 2 && sites.length < 2) continue;
      for (const site of sites)
        findings.push({
          check,
          where: site.where,
          message: `declares port "${name}", which is also declared at ${sites
            .filter(other => other !== site)
            .map(other => other.where)
            .join(
              ', ',
            )}; a port name has one owner, so import the owner's contract and take \`Pick<OwnerApi, ...>\` for a narrower view`,
        });
    }

    // 2. Bindings: a name carried by two different token objects in the manifests.
    const tokensByName = new Map<string, Map<unknown, string[]>>();
    for (const s of model.loaded)
      for (const [field, record] of [
        ['provides', s.manifest.provides],
        ['needs', s.manifest.needs],
        ['uses', s.manifest.uses],
      ] as const)
        for (const token of Object.values(record ?? {}) as readonly { readonly name: string }[]) {
          if (known(s.id, token.name)) continue;
          const byToken = tokensByName.get(token.name) ?? new Map<unknown, string[]>();
          byToken.set(token, [...(byToken.get(token) ?? []), `${s.id} ${field}`]);
          tokensByName.set(token.name, byToken);
        }
    for (const [name, byToken] of tokensByName)
      if (byToken.size > 1)
        findings.push({
          check,
          where: [...byToken.values()].flat().sort().join(', '),
          message: `port "${name}" is bound through ${byToken.size} different tokens; every uses/needs must import the provider's own contract export`,
        });
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
