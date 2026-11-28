/**
 * `context-imports` (§2.1, §7.9, spine §4): a package imports another's non-contract files; a contract imports anything
 * but `zod`, `@ferretry/std`, `@ferretry/kernel/contract` and other contracts; a manifest imports anything but the
 * kernel's manifest SDK, the kernel contract and contracts. `./daemon`, `./app`, `./cli`, `./manifest` are imported
 * only by the generated registries, except Runtimes' public `@ferretry/plugin-runtimes/import-kit` (an app half may import exactly
 * that) and the build seam: the shell's `vite.config.ts` imports a plugin's
 * `app/vite-<name>.ts`. Type-only imports count: a type edge is still an edge.
 */
import { dirname, resolve } from 'node:path';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import type { Area, ImportEdge } from '../gen/lib/imports.ts';

/** The packages whose tests drive Onboarding's real setup flow (see the second exemption in `refusal`). */
const FLOW_DRIVING_TESTS: ReadonlySet<string> = new Set([
  '@ferretry/plugin-claude-code',
  '@ferretry/plugin-codex',
  '@ferretry/plugin-warden',
]);

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
    // Its own folders' barrels (`contract/generated/<folder>.ts`, written by the generator from `contract/<folder>/`).
    if (from === 'contract' && to === 'generated' && same && /^\.\/generated\/[a-z-]+\.ts$/.test(edge.specifier))
      return undefined;
    if (toStd || to === 'kernel-contract' || to === 'contract') return undefined;
    return `a contract imports only zod, @ferretry/std, @ferretry/kernel/contract and contracts, not ${name}`;
  }
  // Rule 4: a manifest's imports.
  if (from === 'manifest' || from === 'kernel-plugin') {
    // Its own fragments' list (`manifest/generated/actions.ts`, written by the generator from `manifest/actions/`).
    if (from === 'manifest' && to === 'generated' && same && edge.specifier === './manifest/generated/actions.ts')
      return undefined;
    // Its own fragments and kit (`manifest/actions/*.ts`, `manifest/kit.ts`): the same manifest, split across files.
    if (from === 'manifest' && to === 'manifest' && same) return undefined;
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
    // The half's own feature list (`daemon/generated/features.ts`, written by the generator from `daemon/features/`).
    if (from === 'daemon' && to === 'generated' && /^\.\/generated\/features\.ts$/.test(edge.specifier))
      return undefined;
    // The half's own verb list (`cli/generated/verbs.ts`, written by the generator from `cli/verbs/`).
    if (from === 'cli' && to === 'generated' && /^\.\/generated\/verbs\.ts$/.test(edge.specifier)) return undefined;
    if (from === 'app' && (to === 'kernel-plugin' || to === 'kernel-manifest' || to === 'kernel-contract'))
      return undefined;
    return `the ${from} half imports its own ${to} files; halves share only the manifest and the contract`;
  }

  // The app shell's public API (lead decision 10, `packages/app/README.md`): an app half imports `@ferretry/app`,
  // `@ferretry/app/ui` and `@ferretry/app/worker`; its tests may also import the test support in `/testing`, the real-browser
  // support in `/testing/browser` (one shared Chromium per test process) and the test router in `/testing/router` and the real Settings shell for a plugin's browser scene in `/testing/settings-shell`.
  if (toPkg.kind === 'shell' && toPkg.name === '@ferretry/app' && edge.specifier.startsWith('@ferretry/app')) {
    const subpath = edge.specifier.slice('@ferretry/app'.length);
    if (
      from === 'tests' &&
      ['', '/ui', '/worker', '/testing', '/testing/browser', '/testing/router', '/testing/settings-shell'].includes(
        subpath,
      )
    )
      return undefined;
    if (from === 'app' && ['', '/ui', '/worker'].includes(subpath)) return undefined;
    // THE PURE SUBPATHS A WORKER CAN IMPORT (r12 H11): the `fy-render` numbers and palette, and the reference grammar. The root
    // entry starts the whole shell, which a Web Worker must not carry (`tests/integration/app/durian-worker-bundle.test.ts`
    // holds the Durian worker to it), so these two files of plain data and pure functions have entries of their own.
    if (from === 'app' && ['/fy-render', '/references/grammar'].includes(subpath)) return undefined;
    if (from === 'tests')
      return `${edge.specifier} is not the app shell's public API: tests import @ferretry/app, /ui, /worker, /testing, /testing/browser, /testing/router and /testing/settings-shell only`;
    return `${edge.specifier} is imported only by app halves (and @ferretry/app/testing only by tests)`;
  }

  // ONE PUBLIC APP EXPORT: Runtimes' import kit (`@ferretry/plugin-runtimes/import-kit`, r10 O8) is what Claude Code's and Codex's
  // onboarding pages are built on. An app half may import exactly that specifier; no other path of Runtimes' app half, no wildcard.
  if (from === 'app' && edge.specifier === '@ferretry/plugin-runtimes/import-kit') return undefined;

  // The build seam: a plugin's build needs (workers, aliases, a build-time transform) live in its `app/vite-<name>.ts`, and
  // the shell's single `vite.config.ts` takes them from there. There is no per-plugin `build.ts` yet, and a config
  // that cannot import them cannot apply them; nothing else of a plugin's half is reachable this way.
  if (
    edge.fromPkg.kind === 'shell' &&
    edge.from.endsWith('/vite.config.ts') &&
    to === 'app' &&
    /\/app\/vite-[a-z][a-z-]*\.ts$/u.test(edge.specifier)
  )
    return undefined;

  // ONE EXEMPTION: the send path is one path split by ownership (Conversation keeps the files, the Mailbox the rules), and
  // its integration proof drives the real halves together. Only Conversation's tests may reach the Mailbox's daemon half.
  if (
    from === 'tests' &&
    edge.fromPkg.name === '@ferretry/plugin-conversation' &&
    toPkg.name === '@ferretry/core-mailbox' &&
    to === 'daemon'
  )
    return undefined;

  // SECOND EXEMPTION: a step page's behaviour (a skip is recorded on the machine and drops the page for the run; Back, Later and
  // busy live in the frame) exists only in Onboarding's setup flow, so the Claude Code and Codex import pages' tests
  // drive the real flow screen. Only those two packages' tests may reach Onboarding's app half and its manifest, and only for that.
  if (
    from === 'tests' &&
    FLOW_DRIVING_TESTS.has(edge.fromPkg.name) &&
    toPkg.name === '@ferretry/plugin-onboarding' &&
    (to === 'app' || to === 'manifest')
  )
    return undefined;

  // THIRD EXEMPTION: Gate's loosening judge decides what a remote device's import may put into effect, and the proof that one
  // import is ONE act on one passkey (C59 O5-10b) needs that judge over the REAL halves that write (Runtimes, Claude Code).
  // Only Gate's tests may load halves, and only through the generated daemon registry, never a half's own path.
  if (
    from === 'tests' &&
    edge.fromPkg.name === '@ferretry/core-gate' &&
    toPkg.id === 'kernel' &&
    to === 'generated' &&
    /\/src\/generated\/plugins\.ts$/u.test(edge.specifier)
  )
    return undefined;

  // FOURTH EXEMPTION: the same proof needs Gate's PRODUCTION admission over Access's REAL step-up service, and a stand-in
  // witness could not tell a passkey proved for the named act from any other, nor a spent window from a held one (C59 O5-10b
  // R1). Only Gate's tests may reach exactly two Access files: the witness adapter Access itself provides to Gate, and the
  // step-up fixture Access's own tests build the real service with.
  if (
    from === 'tests' &&
    edge.fromPkg.name === '@ferretry/core-gate' &&
    toPkg.id === 'access' &&
    /\/access\/(daemon\/step-up-provider|tests\/support\/daemon\/step-up-fixture)\.ts$/u.test(edge.specifier)
  )
    return undefined;

  // FIFTH EXEMPTION: Projects' "where it works" panel hands the New ferret page ONE value (the folder a start sends), and the
  // proof that what the panel SHOWS is what the page SENDS needs the REAL page around the REAL panel: a stand-in page
  // cannot tell a folder left over from the other mode from the one the person sees (O9-9). Only Projects' tests may reach
  // exactly two Ferrets app files: the page and the client type it takes. Runtimes' tests are the same case for the runtime
  // field: the page keeps what the picker proposes in state, and only the REAL page around the REAL picker can show that the
  // two settle (a picker that proposed a new object on every draw drew the page for ever, U6b).
  if (
    from === 'tests' &&
    (edge.fromPkg.name === '@ferretry/plugin-projects' || edge.fromPkg.name === '@ferretry/plugin-runtimes') &&
    toPkg.name === '@ferretry/core-ferrets' &&
    to === 'app' &&
    /\/app\/(features\/new-ferret\/new-ferret-page|lib\/client)\.ts(x)?$/u.test(edge.specifier)
  )
    return undefined;

  // SIXTH EXEMPTION: a question card is the Agenda's own record, and whether it survives a refused answer (Asks applies the
  // source BEFORE it records, inside its board mutation, and leaves the card open when the source refuses) exists only in the
  // real Asks half. Only Conversation's tests may reach the one harness Asks' own tests mount that half with.
  if (
    from === 'tests' &&
    edge.fromPkg.name === '@ferretry/plugin-conversation' &&
    toPkg.id === 'asks' &&
    /\/asks\/tests\/support\/daemon\/asks-half\.ts$/u.test(edge.specifier)
  )
    return undefined;

  // SEVENTH EXEMPTION: E-276's import goldens and threading proof must use the REAL harness kits, just as the settings
  // sources supply them. Only these named Runtimes tests may import exactly the two kit entry points; no other half.
  if (
    from === 'tests' &&
    edge.fromPkg.name === '@ferretry/plugin-runtimes' &&
    [
      'tests/unit/golden/host-import.golden.test.ts',
      'tests/unit/golden/setup-import.golden.test.ts',
      'tests/unit/golden/consumers.golden.test.ts',
      'tests/unit/lib/import-kit-threading.test.ts',
      'tests/unit/daemon/host-harness-scan.test.ts',
      'tests/unit/daemon/host-harness-scan-projects.test.ts',
      'tests/integration/host-harness-scan.test.ts',
      'tests/integration/daemon/host-harness-scan-roots.test.ts',
      'tests/integration/daemon/file-deps.test.ts',
      'tests/unit/daemon/composed-daemon.test.ts',
      'tests/unit/daemon/generic-runtime.test.ts',
      'tests/unit/daemon/import-fresh-home.test.ts',
      'tests/unit/lib/account-import.test.ts',
      'tests/unit/lib/account-import-skip.test.ts',
      'tests/unit/lib/account-import-retry.test.ts',
      'tests/unit/lib/account-import-login-env.test.ts',
      'tests/unit/lib/account-import-branches.test.ts',
      'tests/unit/daemon/setup-service.test.ts',
      'tests/unit/golden/credentials.golden.test.ts',
      'tests/unit/golden/support/world.ts',
      'tests/support/real-kits.ts',
    ].includes(edge.from.slice(edge.fromPkg.dir.length + 1)) &&
    to === 'daemon' &&
    ['@ferretry/plugin-claude-code', '@ferretry/plugin-codex'].includes(toPkg.name) &&
    resolve(dirname(edge.from), edge.specifier) === resolve(toPkg.dir, 'daemon/lib/runtimes-kit/index.ts')
  )
    return undefined;

  // EIGHTH EXEMPTION: E-276 PR 12 moved three Codex-only modules into the Codex plugin, and the two frozen Runtimes goldens
  // that exercise them still do. Only these two named golden tests may import only these named modules, by path; no glob.
  if (
    from === 'tests' &&
    edge.fromPkg.name === '@ferretry/plugin-runtimes' &&
    to === 'daemon' &&
    toPkg.name === '@ferretry/plugin-codex' &&
    (
      {
        'tests/unit/golden/supervision.golden.test.ts': [
          'daemon/lib/runtimes-kit/codex-runtime.ts',
          'daemon/lib/runtimes-kit/runtime-end-supervision.ts',
        ],
        'tests/unit/golden/mcp.golden.test.ts': ['daemon/lib/runtimes-kit/model-catalog.ts'],
      } as Readonly<Record<string, readonly string[]>>
    )[edge.from.slice(edge.fromPkg.dir.length + 1)]?.some(
      module => resolve(dirname(edge.from), edge.specifier) === resolve(toPkg.dir, module),
    ) === true
  )
    return undefined;

  // NINTH EXEMPTION: E-276 PR 15 made Ferrets read a harness's transcript format, history pool and footer flag from its
  // own `HarnessFacts`, and the one frozen Ferrets golden that pins those answers must be given the REAL facts of the two
  // shipped harnesses (not copies that could drift). Only that one named test may import exactly those two facts files.
  if (
    from === 'tests' &&
    edge.fromPkg.name === '@ferretry/core-ferrets' &&
    edge.from.slice(edge.fromPkg.dir.length + 1) === 'tests/unit/golden/transcript-harness.test.ts' &&
    to === 'daemon' &&
    [
      ['@ferretry/plugin-claude-code', 'daemon/lib/harness/facts.ts'],
      ['@ferretry/plugin-codex', 'daemon/lib/facts.ts'],
    ].some(
      ([name, file]) =>
        toPkg.name === name && resolve(dirname(edge.from), edge.specifier) === resolve(toPkg.dir, file!),
    )
  )
    return undefined;

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
