/**
 * HOW THIS MACHINE'S `claude` AND `codex` WERE INSTALLED, WHETHER FERRETRY HAS VERIFIED THE VERSION THEY
 * RUN, AND WHAT UPDATING EACH ONE TAKES.
 *
 * The daemon's own update (`daemon-update.ts`) already answers "how was this executable installed?" for
 * itself. A harness is the same question about a different file, so this module reuses that answer's
 * pieces — the link chain, the nix profile listing, the store-path rule ({@link classifyNixStorePath})
 * and the module steps ({@link nixModuleUpdate}) — and adds only what a harness has and the daemon does
 * not: npm-style globals, Homebrew formulae, and Claude Code's own installer.
 *
 * Pure: reading a fact, running a package manager and asking the registry are the daemon's adapters'.
 * The contract and its reasons are `docs/updating.md` › "Updating Claude Code and Codex".
 */

import { z } from 'zod';
import { InstantSchema } from './common.ts';
import {
  classifyNixStorePath,
  describeInstallMethod,
  INSTALL_METHOD_LABELS,
  isNixStoreFile,
  knownLatestRelease,
  type LatestRelease,
  NixModuleManagerSchema,
  type NixPathFacts,
  NixSystemManagerSchema,
  nixModuleUpdate,
  RELEASE_OWNER,
  UpdateCheckSchema,
  type UpdateStep,
  UpdateStepSchema,
} from './daemon-update.ts';
import { type Harness, HarnessSchema } from './session-base.ts';
import { compareProtocolVersions, ProtocolVersionSchema } from './version-skew.ts';

/** Each harness as a person names it. */
export const HARNESS_CLI_LABELS: Readonly<Record<Harness, string>> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * THE one place a harness's package names are spelled: its npm package, its Homebrew cask, and its
 * nixpkgs attribute. The daemon's tool install (`fleet/tool-install.ts`) reads the same table.
 */
export const HARNESS_PACKAGES: Readonly<
  Record<Harness, { readonly npm: string; readonly cask: string; readonly nixpkgs: string }>
> = {
  claude: { npm: '@anthropic-ai/claude-code', cask: 'claude-code', nixpkgs: 'claude-code' },
  codex: { npm: '@openai/codex', cask: 'codex', nixpkgs: 'codex' },
};

/**
 * THE VERSIONS FERRETRY HAS VERIFIED: what the harness contract guard (`packages/fleet/tests/contract`)
 * measures in every build, which is the `claude-code` and `codex` of the flake's locked nixpkgs.
 *
 * This constant is the owner; `run.sh pinned` fails when what it measured is not this, so the two can
 * never drift — bumping `flake.lock` onto a new harness means bumping this line in the same change.
 */
export const VERIFIED_HARNESS_VERSIONS: Readonly<Record<Harness, string>> = {
  claude: '2.1.220',
  codex: '0.145.0',
};

/** What "verified" means and what is known to break past it: the contract guard's own README. */
export const harnessVerificationUrl = (product: string): string =>
  `https://github.com/${RELEASE_OWNER}/${product}/blob/main/packages/fleet/tests/contract/README.md`;

/** The registry address of a package's `latest` dist-tag. */
export const npmLatestUrl = (packageName: string): string => `https://registry.npmjs.org/${packageName}/latest`;

/** Where a person reads what changed in one harness version. */
export function harnessChangelogUrl(harness: Harness, version: string): string {
  return harness === 'claude'
    ? 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md'
    : `https://github.com/openai/codex/releases/tag/rust-v${version}`;
}

// ---------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------

/**
 * The version a harness's `--version` printed — `2.1.220 (Claude Code)`, `codex-cli 0.145.0` — or
 * `undefined` when there is none to read.
 */
export function parseHarnessVersion(output: string): string | undefined {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(output);
  return match?.[1];
}

/** The `latest` version from a registry answer, or `undefined` for anything that is not a stable one. */
export function parseNpmLatest(harness: Harness, value: unknown): LatestRelease | undefined {
  const parsed = z.looseObject({ version: z.string() }).safeParse(value);
  if (!parsed.success) return undefined;
  const version = parsed.data.version;
  if (!ProtocolVersionSchema.safeParse(version).success || version.includes('-')) return undefined;
  return { version, url: harnessChangelogUrl(harness, version) };
}

/**
 * Where a version stands against the one Ferretry verified. `unverified` is NEWER than that — the case
 * that needs a person's explicit yes; `older` still runs, it is simply behind what was measured.
 */
export const HarnessVerificationSchema = z.enum(['verified', 'older', 'unverified', 'unknown']);
export type HarnessVerification = z.infer<typeof HarnessVerificationSchema>;

export function harnessVerification(harness: Harness, version: string | undefined): HarnessVerification {
  if (version === undefined) return 'unknown';
  const comparison = compareProtocolVersions(version, VERIFIED_HARNESS_VERSIONS[harness]);
  if (comparison === 0) return 'verified';
  if (comparison === -1) return 'older';
  return comparison === 1 ? 'unverified' : 'unknown';
}

// ---------------------------------------------------------------------------------------------------
// Install method
// ---------------------------------------------------------------------------------------------------

/** The tool that owns a JavaScript global install. */
export const NodePackageToolSchema = z.enum(['npm', 'pnpm', 'bun', 'volta']);
export type NodePackageTool = z.infer<typeof NodePackageToolSchema>;

/** The node version manager an npm prefix belongs to — said, because it decides which `npm` is meant. */
export const NodeVersionManagerSchema = z.enum(['nvm', 'fnm', 'asdf', 'mise']);
export type NodeVersionManager = z.infer<typeof NodeVersionManagerSchema>;

export const HarnessInstallMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('npm-global'),
    tool: NodePackageToolSchema,
    package: z.string().min(1),
    /** The npm prefix (`npm install -g --prefix`), for `npm` only. */
    prefix: z.string().min(1).optional(),
    nodeManager: NodeVersionManagerSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('homebrew'), type: z.enum(['cask', 'formula']), package: z.string().min(1) }),
  z.strictObject({ kind: z.literal('nix-profile'), element: z.string().min(1) }),
  z.strictObject({ kind: z.literal('nix-shell'), storePath: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('nix-module'),
    manager: NixModuleManagerSchema,
    via: NixSystemManagerSchema.optional(),
  }),
  /** Claude Code's own installer (`claude install`), which keeps its versions under `~/.local/share/claude`. */
  z.strictObject({ kind: z.literal('native-installer'), directory: z.string().min(1) }),
  z.strictObject({ kind: z.literal('standalone'), directory: z.string().min(1) }),
  z.strictObject({ kind: z.literal('unknown'), reason: z.string().min(1) }),
]);
export type HarnessInstallMethod = z.infer<typeof HarnessInstallMethodSchema>;
export type HarnessInstallMethodKind = HarnessInstallMethod['kind'];

/** Every fact {@link classifyHarnessInstall} reads, gathered by an adapter for the file a runtime launches. */
export interface HarnessInstallFacts extends NixPathFacts {
  readonly harness: Harness;
}

const parentDirectory = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const NODE_MANAGERS: readonly [RegExp, NodeVersionManager][] = [
  [/\/\.nvm\//u, 'nvm'],
  [/\/\.?fnm\//u, 'fnm'],
  [/\/\.asdf\//u, 'asdf'],
  [/\/mise\//u, 'mise'],
];

function npmGlobal(harness: Harness, facts: HarnessInstallFacts): HarnessInstallMethod | undefined {
  const packageName = HARNESS_PACKAGES[harness].npm;
  // A Volta shim resolves to `volta-shim`, never into the package, so the LAUNCHED path is what says so.
  if (facts.launchedPath.includes('/.volta/') || facts.resolvedPath.includes('/.volta/'))
    return { kind: 'npm-global', tool: 'volta', package: packageName };
  const resolved = facts.resolvedPath;
  const marker = `/node_modules/${packageName}/`;
  if (!resolved.includes(marker)) return undefined;
  if (resolved.includes('/.bun/install/global/')) return { kind: 'npm-global', tool: 'bun', package: packageName };
  if (/\/pnpm\/global\/|\/\.pnpm\//u.test(resolved)) return { kind: 'npm-global', tool: 'pnpm', package: packageName };
  const lib = resolved.indexOf('/lib/node_modules/');
  const prefix = lib > 0 ? resolved.slice(0, lib) : resolved.slice(0, resolved.indexOf(marker));
  const nodeManager = NODE_MANAGERS.find(([pattern]) => pattern.test(prefix))?.[1];
  return {
    kind: 'npm-global',
    tool: 'npm',
    package: packageName,
    ...(prefix === '' ? {} : { prefix }),
    ...(nodeManager === undefined ? {} : { nodeManager }),
  };
}

/**
 * Decide how one harness was installed, from the file a runtime actually launches.
 *
 * ORDER MATTERS, most certain first. A Caskroom is unambiguous. A store path is decided by HOW it was
 * reached, exactly as the daemon's own is — and it is asked BEFORE the npm layout, because nixpkgs'
 * `claude-code` is itself a `lib/node_modules/@anthropic-ai/claude-code` inside the store. Then the
 * JavaScript globals, Homebrew formulae, Claude Code's own installer, and anything else is a standalone
 * file whose update this cannot do.
 */
export function classifyHarnessInstall(facts: HarnessInstallFacts): HarnessInstallMethod {
  const resolved = facts.resolvedPath;
  const cask = /\/Caskroom\/([^/]+)\//u.exec(resolved)?.[1];
  if (cask !== undefined) return { kind: 'homebrew', type: 'cask', package: cask };
  if (isNixStoreFile(resolved)) return classifyNixStorePath(facts);
  const npm = npmGlobal(facts.harness, facts);
  if (npm !== undefined) return npm;
  const formula = /\/Cellar\/([^/]+)\//u.exec(resolved)?.[1];
  if (formula !== undefined) return { kind: 'homebrew', type: 'formula', package: formula };
  const nativeRoot = `${facts.homeDirectory.replace(/\/+$/u, '')}/.local/share/claude`;
  if (facts.harness === 'claude' && resolved.startsWith(`${nativeRoot}/`))
    return { kind: 'native-installer', directory: nativeRoot };
  return { kind: 'standalone', directory: parentDirectory(resolved) };
}

/** A short, plain name for each method. */
export function harnessInstallLabel(method: HarnessInstallMethod): string {
  switch (method.kind) {
    case 'npm-global':
      return method.tool === 'volta' ? 'Volta' : `${method.tool} global`;
    case 'homebrew':
      return 'Homebrew';
    case 'native-installer':
      return 'Claude Code installer';
    case 'nix-profile':
    case 'nix-shell':
    case 'nix-module':
    case 'standalone':
    case 'unknown':
      return INSTALL_METHOD_LABELS[method.kind];
  }
}

/** The label, with the detail a person needs to recognise their own install. */
export function describeHarnessInstall(method: HarnessInstallMethod): string {
  switch (method.kind) {
    case 'npm-global': {
      const where = method.prefix === undefined ? '' : ` in ${method.prefix}`;
      const node = method.nodeManager === undefined ? '' : ` (node from ${method.nodeManager})`;
      return `${method.tool} global package ${method.package}${where}${node}`;
    }
    case 'homebrew':
      return `Homebrew ${method.type} ${method.package}`;
    case 'native-installer':
      return `Claude Code's own installer, in ${method.directory}`;
    case 'nix-profile':
    case 'nix-shell':
    case 'nix-module':
    case 'standalone':
    case 'unknown':
      return describeInstallMethod(method);
  }
}

// ---------------------------------------------------------------------------------------------------
// What updating takes
// ---------------------------------------------------------------------------------------------------

/** The programs an update runs. `harness` is the harness's own binary (`claude update`). */
export const HarnessUpdateProgramSchema = z.enum(['npm', 'pnpm', 'bun', 'volta', 'brew', 'nix', 'harness']);
export type HarnessUpdateProgram = z.infer<typeof HarnessUpdateProgramSchema>;

/**
 * One command an update runs: a program and its arguments, never a shell string. What a person reads
 * ({@link harnessCommandLine}) is built from the same argv the daemon runs.
 */
export interface HarnessCommand {
  readonly program: HarnessUpdateProgram;
  readonly args: readonly string[];
}

/** A command as a person types it. */
export function harnessCommandLine(harness: Harness, command: HarnessCommand): string {
  return [command.program === 'harness' ? harness : command.program, ...command.args].join(' ');
}

/** What updating one harness takes, for one install method. */
export type HarnessUpdateRecipe =
  | {
      readonly kind: 'self';
      readonly run: readonly HarnessCommand[];
      /** Whether the method installs exactly the version asked for; Homebrew and nix take what they have. */
      readonly pinsVersion: boolean;
      /** What puts the previous version back, given it; `undefined` when the method keeps none. */
      readonly rollback: ((previous: string) => readonly HarnessCommand[]) | undefined;
    }
  | { readonly kind: 'manual'; readonly explanation: string; readonly steps: readonly UpdateStep[] };

function nodeInstall(method: Extract<HarnessInstallMethod, { kind: 'npm-global' }>, version: string): HarnessCommand {
  const spec = `${method.package}@${version}`;
  switch (method.tool) {
    case 'npm':
      return {
        program: 'npm',
        args: ['install', '-g', ...(method.prefix === undefined ? [] : ['--prefix', method.prefix]), spec],
      };
    case 'pnpm':
      return { program: 'pnpm', args: ['add', '-g', spec] };
    case 'bun':
      return { program: 'bun', args: ['add', '-g', spec] };
    case 'volta':
      return { program: 'volta', args: ['install', spec] };
  }
}

/**
 * What updating takes for this harness and method, to `target` (`undefined` is "the newest").
 *
 * Only a method that needs no `sudo` and changes nobody's configuration is `self`, the same line the
 * daemon's own update draws: a module install is pinned by somebody's flake, a temporary nix shell is
 * gone at the next garbage collection, and a binary Ferretry did not recognise is not Ferretry's to
 * replace.
 */
export function harnessUpdateRecipe(
  harness: Harness,
  method: HarnessInstallMethod,
  target: string | undefined,
): HarnessUpdateRecipe {
  const label = HARNESS_CLI_LABELS[harness];
  const packages = HARNESS_PACKAGES[harness];
  switch (method.kind) {
    case 'npm-global':
      return {
        kind: 'self',
        run: [nodeInstall(method, target ?? 'latest')],
        pinsVersion: true,
        rollback: previous => [nodeInstall(method, previous)],
      };
    case 'homebrew':
      return {
        kind: 'self',
        run: [
          { program: 'brew', args: ['update'] },
          {
            program: 'brew',
            args: method.type === 'cask' ? ['upgrade', '--cask', method.package] : ['upgrade', method.package],
          },
        ],
        pinsVersion: false,
        rollback: undefined,
      };
    case 'nix-profile':
      return {
        kind: 'self',
        run: [{ program: 'nix', args: ['profile', 'upgrade', '--refresh', method.element] }],
        pinsVersion: false,
        rollback: () => [{ program: 'nix', args: ['profile', 'rollback'] }],
      };
    case 'native-installer':
      return {
        kind: 'self',
        run: [
          target === undefined
            ? { program: 'harness', args: ['update'] }
            : { program: 'harness', args: ['install', target] },
        ],
        pinsVersion: true,
        rollback: previous => [{ program: 'harness', args: ['install', previous] }],
      };
    case 'nix-module': {
      const update = nixModuleUpdate(method, {
        subject: label,
        input: 'nixpkgs',
        inputNote: `the input that provides ${packages.nixpkgs} is usually nixpkgs, or an overlay that packages it`,
      });
      return { kind: 'manual', explanation: update.explanation, steps: update.steps };
    }
    case 'nix-shell':
      return {
        kind: 'manual',
        explanation: `${label} here runs from a temporary nix shell store path, which never updates and which garbage collection can delete. Install it into your nix profile, and every later update is one click.`,
        steps: [{ command: `nix profile install nixpkgs#${packages.nixpkgs}` }],
      };
    case 'standalone':
      return {
        kind: 'manual',
        explanation:
          harness === 'claude'
            ? `${label} here is a file in ${method.directory} that no package manager Ferretry knows owns. Reinstall it with Claude Code's own installer, and later updates are one click.`
            : `${label} here is a file in ${method.directory} that no package manager Ferretry knows owns — usually a binary from its GitHub releases. Replace it with the new release, or reinstall with npm so later updates are one click.`,
        steps:
          harness === 'claude'
            ? [{ command: 'curl -fsSL https://claude.ai/install.sh | bash' }]
            : [
                {
                  command: `npm install -g ${packages.npm}`,
                  note: 'or download the new release from https://github.com/openai/codex/releases/latest',
                },
              ],
      };
    case 'unknown':
      return { kind: 'manual', explanation: `Ferretry cannot update ${label} here: ${method.reason}.`, steps: [] };
  }
}

export const HarnessUpdatePlanSchema = z.discriminatedUnion('kind', [
  /** Ferretry can do it: one click in the app, or `fy harness update`. */
  z.strictObject({
    kind: z.literal('self'),
    steps: z.array(UpdateStepSchema).min(1),
    /** Whether a failed check after the update puts the previous version back on its own. */
    rollback: z.enum(['automatic', 'none']),
    /** Whether a chosen version can be installed; Homebrew and nix install the newest they have. */
    pinsVersion: z.boolean(),
  }),
  /** Somebody has to do it, and these are the exact steps. */
  z.strictObject({ kind: z.literal('manual'), explanation: z.string().min(1), steps: z.array(UpdateStepSchema) }),
]);
export type HarnessUpdatePlan = z.infer<typeof HarnessUpdatePlanSchema>;

/** The recipe as a person reads it. */
export function harnessUpdatePlan(
  harness: Harness,
  method: HarnessInstallMethod,
  target: string | undefined,
): HarnessUpdatePlan {
  const recipe = harnessUpdateRecipe(harness, method, target);
  if (recipe.kind === 'manual') return { kind: 'manual', explanation: recipe.explanation, steps: [...recipe.steps] };
  return {
    kind: 'self',
    steps: recipe.run.map(command => ({ command: harnessCommandLine(harness, command) })),
    rollback: recipe.rollback === undefined ? 'none' : 'automatic',
    pinsVersion: recipe.pinsVersion,
  };
}

// ---------------------------------------------------------------------------------------------------
// The daemon's view
// ---------------------------------------------------------------------------------------------------

/** Which file a runtime launches for this harness, and the rule that chose it (`docs/harness-paths.md`). */
export const HarnessCliLocationSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('located'),
    path: z.string().min(1),
    rule: z.string().min(1),
    declaredBy: z.string().min(1),
  }),
  z.strictObject({
    state: z.literal('override-absent'),
    path: z.string().min(1),
    declaredBy: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.strictObject({ state: z.literal('absent'), searched: z.array(z.string()) }),
]);
export type HarnessCliLocation = z.infer<typeof HarnessCliLocationSchema>;

/** What that file's `--version` said. */
export const HarnessInstalledVersionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ok'), version: ProtocolVersionSchema }),
  z.strictObject({ state: z.literal('unreadable'), reason: z.string().min(1) }),
]);
export type HarnessInstalledVersion = z.infer<typeof HarnessInstalledVersionSchema>;

export const HarnessUpdateOutcomeSchema = z.enum(['succeeded', 'unchanged', 'rolled-back', 'failed']);
export type HarnessUpdateOutcome = z.infer<typeof HarnessUpdateOutcomeSchema>;

/** How the last update of one harness ended, in one plain sentence. */
export const HarnessUpdateReportSchema = z.strictObject({
  from: ProtocolVersionSchema.optional(),
  /** The version the harness runs now, when it could be read. */
  to: ProtocolVersionSchema.optional(),
  target: ProtocolVersionSchema.optional(),
  outcome: HarnessUpdateOutcomeSchema,
  message: z.string().min(1),
  finishedAt: InstantSchema,
});
export type HarnessUpdateReport = z.infer<typeof HarnessUpdateReportSchema>;

export const HarnessUpdateJobSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('running'),
    target: ProtocolVersionSchema.optional(),
    startedAt: InstantSchema,
    /** The command running now. */
    command: z.string().min(1),
  }),
  z.strictObject({ state: z.literal('finished'), report: HarnessUpdateReportSchema }),
]);
export type HarnessUpdateJob = z.infer<typeof HarnessUpdateJobSchema>;

export const HarnessCliViewSchema = z.strictObject({
  harness: HarnessSchema,
  location: HarnessCliLocationSchema,
  /** `null` when nothing was located to ask. */
  installed: HarnessInstalledVersionSchema.nullable(),
  method: HarnessInstallMethodSchema.nullable(),
  /** What updating to the newest takes; `null` when nothing was located. */
  plan: HarnessUpdatePlanSchema.nullable(),
  /** The newest version on npm, asked when somebody looks — never on a timer. */
  check: UpdateCheckSchema,
  /** The version Ferretry verified, and where that is explained. */
  verified: z.strictObject({ version: ProtocolVersionSchema, url: z.url() }),
  /** Where the installed version stands against it. */
  verification: HarnessVerificationSchema,
  /** A newer version than the installed one is known. */
  available: z.boolean(),
  job: HarnessUpdateJobSchema.nullable(),
});
export type HarnessCliView = z.infer<typeof HarnessCliViewSchema>;

export const HarnessUpdateViewSchema = z.strictObject({ harnesses: z.array(HarnessCliViewSchema) });
export type HarnessUpdateView = z.infer<typeof HarnessUpdateViewSchema>;

export const HarnessUpdateStartRequestSchema = z.strictObject({
  harness: HarnessSchema,
  /** The version to install; absent is the newest the method offers. */
  target: ProtocolVersionSchema.optional(),
  /** The person's explicit yes to going past the version Ferretry verified. */
  confirmUnverified: z.boolean().optional(),
});
export type HarnessUpdateStartRequest = z.infer<typeof HarnessUpdateStartRequestSchema>;

/** Refusal codes the harness update route answers with. */
export const HARNESS_UPDATE_CODES = {
  unverified: 'harness_update_unverified',
  inProgress: 'harness_update_in_progress',
  notLocated: 'harness_update_not_located',
  notSelfUpdatable: 'harness_update_not_self_updatable',
  notTargetable: 'harness_update_not_targetable',
  notAvailable: 'harness_update_not_available',
} as const;

/** The `409 harness_update_unverified` body: what would be installed, and what Ferretry verified. */
export const HarnessUpdateUnverifiedBodySchema = z.looseObject({
  error: z.string(),
  code: z.literal(HARNESS_UPDATE_CODES.unverified),
  target: ProtocolVersionSchema.optional(),
  verified: ProtocolVersionSchema,
});
export type HarnessUpdateUnverifiedBody = z.infer<typeof HarnessUpdateUnverifiedBodySchema>;

/** The version a view says is installed, when it could be read. */
export const installedHarnessVersion = (view: HarnessCliView): string | undefined =>
  view.installed?.state === 'ok' ? view.installed.version : undefined;

/**
 * The versions a person may be offered: the newest known, and — when the method can install a chosen
 * version and the verified one is between what runs and the newest — the verified one too.
 */
export function harnessUpdateTargets(view: HarnessCliView): {
  readonly latest?: string;
  readonly verified?: string;
} {
  const installed = installedHarnessVersion(view);
  const latest = knownLatestRelease(view.check)?.version;
  const newer = (version: string | undefined): version is string =>
    version !== undefined && (installed === undefined || compareProtocolVersions(version, installed) === 1);
  const verified = view.verified.version;
  const offerVerified =
    view.plan?.kind === 'self' &&
    view.plan.pinsVersion &&
    newer(verified) &&
    latest !== undefined &&
    compareProtocolVersions(latest, verified) === 1;
  return { ...(newer(latest) ? { latest } : {}), ...(offerVerified ? { verified } : {}) };
}

/**
 * Whether installing `target` (or, for a method that takes what it has, the newest known) goes past what
 * Ferretry verified — which needs the person's explicit yes.
 */
export function needsUnverifiedConsent(harness: Harness, version: string | undefined): boolean {
  return harnessVerification(harness, version) === 'unverified';
}
