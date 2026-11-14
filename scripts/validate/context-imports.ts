/**
 * `context-imports` (§2.1, §7.9, spine §4): a package imports another's non-contract files; a contract imports anything
 * but `zod`, `@ferretry/std`, `@ferretry/kernel/contract` and other contracts; a manifest imports anything but the
 * kernel's manifest SDK, the kernel contract and contracts. `./daemon`, `./app`, `./cli`, `./manifest` are imported
 * only by the generated registries. Type-only imports count: a type edge is still an edge.
 */
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import type { Area, ImportEdge } from '../gen/lib/imports.ts';

const CONTRACT_EXTERNALS = new Set(['zod']);
const MANIFEST_EXTERNALS = new Set(['zod']);

/** Why an edge is refused, or undefined when it is allowed. Pure; the planted-violation tests drive it. */
export function refusal(edge: ImportEdge): string | undefined {
  const from = edge.fromArea;
  if (from === 'generated') return undefined;
  if (edge.external !== undefined) {
    if ((from === 'contract' || from === 'kernel-contract') && !CONTRACT_EXTERNALS.has(edge.external))
      return `a contract imports only zod, @ferretry/std, @ferretry/kernel/contract and contracts, not ${edge.external}`;
    if (from === 'manifest' && !MANIFEST_EXTERNALS.has(edge.external))
      return `a manifest imports only the kernel SDK, the kernel contract and contracts, not ${edge.external}`;
    return undefined;
  }
  const to = edge.toArea as Area | undefined;
  const toPkg = edge.toPkg;
  if (to === undefined || toPkg === undefined) return undefined;
  const same = toPkg === edge.fromPkg;
  const toStd = toPkg.kind === 'shared';
  const name = `${toPkg.name}${to === 'root' ? '' : ` (${to})`}`;

  // Rule 2: a contract's imports.
  if (from === 'contract' || from === 'kernel-contract') {
    if (toStd || to === 'kernel-contract' || to === 'contract') return undefined;
    return `a contract imports only zod, @ferretry/std, @ferretry/kernel/contract and contracts, not ${name}`;
  }
  // Rule 4: a manifest's imports.
  if (from === 'manifest' || from === 'kernel-plugin') {
    if (to === 'kernel-manifest' || to === 'kernel-contract' || to === 'contract' || toStd) return undefined;
    return `a manifest imports only @ferretry/kernel/manifest, @ferretry/kernel/contract and contracts, not ${name}`;
  }
  if (toStd) return undefined;

  // The app shell's public browser facilities are the common seam for app halves.
  // Tests may also use its shared harness; daemon/CLI halves and private src paths may not.
  if (toPkg.name === '@ferretry/app') {
    if ((from === 'app' || from === 'tests') && ['@ferretry/app', '@ferretry/app/ui'].includes(edge.specifier))
      return undefined;
    if (from === 'tests' && edge.specifier === '@ferretry/app/testing') return undefined;
  }

  if (same) {
    if (from === 'tests' || from === 'other' || from === 'root') return undefined;
    if (from.startsWith('kernel-')) {
      if (from === 'kernel-manifest' && (to === 'kernel-host' || to === 'kernel-testing'))
        return `the manifest SDK imports only the kernel contract, not ${to}`;
      return undefined;
    }
    if (from === 'contract-testing') {
      if (to === 'contract' || to === 'contract-testing') return undefined;
      return `contract/testing imports only its contract and other contracts' testing, not ${to}`;
    }
    // A half: its own area, its manifest and its contract. The Kernel's app half has the kernel's own: its manifest
    // (`plugin.ts`), the manifest SDK and the contract, the three every other half reaches by package name.
    if (to === from || to === 'manifest' || to === 'contract') return undefined;
    if (from === 'app' && (to === 'kernel-plugin' || to === 'kernel-manifest' || to === 'kernel-contract'))
      return undefined;
    return `the ${from} half imports its own ${to} files; halves share only the manifest and the contract`;
  }

  // The app shell's public API (lead decision 10, `packages/app/README.md`): an app half imports `@ferretry/app`,
  // `@ferretry/app/ui` and `@ferretry/app/worker`; its tests may also import the test support in `/testing`, the real-browser
  // support in `/testing/browser` (one shared Chromium per test process) and the test router in `/testing/router`.
  if (toPkg.kind === 'shell' && toPkg.name === '@ferretry/app' && edge.specifier.startsWith('@ferretry/app')) {
    const subpath = edge.specifier.slice('@ferretry/app'.length);
    if (from === 'tests' && ['', '/ui', '/worker', '/testing', '/testing/browser', '/testing/router'].includes(subpath))
      return undefined;
    if (from === 'app' && ['', '/ui', '/worker'].includes(subpath)) return undefined;
    if (from === 'tests')
      return `${edge.specifier} is not the app shell's public API: tests import @ferretry/app, /ui, /worker, /testing, /testing/browser and /testing/router only`;
    return `${edge.specifier} is imported only by app halves (and @ferretry/app/testing only by tests)`;
  }

  // Another package.
  switch (to) {
    case 'kernel-contract':
    case 'contract':
      return undefined;
    case 'kernel-manifest':
      return from === 'contract-testing' || ['daemon', 'app', 'cli', 'tests', 'root', 'other'].includes(from)
        ? undefined
        : `${from} may not import the manifest SDK`;
    case 'kernel-testing':
    case 'contract-testing':
      return from === 'tests' || from === 'contract-testing' || from === 'kernel-testing'
        ? undefined
        : `${to === 'kernel-testing' ? '@ferretry/kernel/testing' : `${toPkg.name}/contract/testing`} is for tests only`;
    case 'kernel-worker':
      return from === 'daemon' || from === 'tests' || from === 'kernel-testing'
        ? undefined
        : "@ferretry/kernel/worker is imported only by a daemon half's worker module";
    case 'kernel-host':
      return edge.fromPkg.kind === 'shell' || from === 'tests' || from === 'kernel-testing'
        ? undefined
        : '@ferretry/kernel/host is imported only by the shells and the test host';
    default:
      return `imports ${name}; another package is reached only through its contract (the generated registries load halves)`;
  }
}

export const check: Check = {
  name: 'context-imports',
  summary: 'packages meet only through contracts',
  async run(ctx) {
    const model = await ctx.model();
    const findings: Finding[] = [];
    for (const edge of model.edges) {
      if (ctx.packageId !== undefined && edge.fromPkg.id !== ctx.packageId) continue;
      const why = refusal(edge);
      if (why !== undefined)
        findings.push({
          check: 'context-imports',
          where: `${edge.from.slice(model.ws.root.length + 1)}:${edge.line}`,
          message: `${edge.specifier}: ${why}`,
        });
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
