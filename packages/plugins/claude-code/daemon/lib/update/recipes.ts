/**
 * HOW THIS MACHINE'S `claude` WAS INSTALLED, WHETHER FERRETRY HAS VERIFIED THE VERSION IT RUNS, AND WHAT
 * UPDATING IT TAKES.
 *
 * Pure: reading a fact, running a package manager and asking the registry are the adapters'. Copied from
 * today's `harness-update.ts` (Claude half only) with the nix-store helpers it shared with the daemon's own
 * update (`isNixStoreFile`, `classifyNixStorePath`, `nixModuleUpdate`) and the version compare it used, so
 * this plugin needs no other. The contract and its reasons are `docs/updating.md` › "Updating Claude Code
 * and Codex".
 */
import type { z } from 'zod';
import {
  type HarnessInstallMethod,
  type HarnessInstalledVersionSchema,
  type HarnessUpdateJobSchema,
  type HarnessUpdateOutcomeSchema,
  type HarnessUpdateReportSchema,
  type HarnessVerification,
  type LatestReleaseSchema,
  type UpdateCheckSchema,
  type UpdateStepSchema,
  VersionSchema,
} from '../../../contract/index.ts';

export type UpdateStep = z.infer<typeof UpdateStepSchema>;
export type LatestRelease = z.infer<typeof LatestReleaseSchema>;
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;
export type HarnessInstalledVersion = z.infer<typeof HarnessInstalledVersionSchema>;
export type HarnessUpdateJob = z.infer<typeof HarnessUpdateJobSchema>;
export type HarnessUpdateOutcome = z.infer<typeof HarnessUpdateOutcomeSchema>;
export type HarnessUpdateReport = z.infer<typeof HarnessUpdateReportSchema>;

/** How a person names this harness. */
export const CLAUDE_CODE_LABEL = 'Claude Code';

/** Where the product's releases are published, for the verification link. */
export const RELEASE_OWNER = 'kirinnee';

/** THE one place the harness's package names are spelled: its npm package, its Homebrew cask, and its nixpkgs attribute. */
export const CLAUDE_CODE_PACKAGES = {
  npm: '@anthropic-ai/claude-code',
  cask: 'claude-code',
  nixpkgs: 'claude-code',
} as const;

/**
 * THE VERSION FERRETRY HAS VERIFIED: what the harness contract guard measures in every build, which is the
 * `claude-code` of the flake's locked nixpkgs. This constant is the owner; the guard fails when what it
 * measured is not this, so the two can never drift.
 */
export const VERIFIED_CLAUDE_CODE_VERSION = '2.1.220';

/** What "verified" means and what is known to break past it: the contract guard's own README. */
export const verificationUrl = (product: string): string =>
  `https://github.com/${RELEASE_OWNER}/${product}/blob/main/packages/plugins/claude-code/tests/contract/README.md`;

/** The registry address of the package's `latest` dist-tag. */
export const npmLatestUrl = (): string => `https://registry.npmjs.org/${CLAUDE_CODE_PACKAGES.npm}/latest`;

/** Where a person reads what changed in a version. */
export const changelogUrl = (): string => 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';

// ─── versions ────────────────────────────────────────────────────────────────────────────────────────────────────

interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
}

function parseVersion(value: string): ParsedVersion | undefined {
  if (!VersionSchema.safeParse(value).success) return undefined;
  const [withoutBuild = ''] = value.split('+');
  const [core = '', pre] = withoutBuild.split('-', 2);
  const [major, minor, patch] = core.split('.').map(part => BigInt(part)) as [bigint, bigint, bigint];
  return { core: [major, minor, patch], prerelease: pre === undefined ? [] : pre.split('.') };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const leftNumeric = /^\d+$/u.test(l);
    const rightNumeric = /^\d+$/u.test(r);
    if (leftNumeric && rightNumeric) return BigInt(l) > BigInt(r) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

/** Semver order; `undefined` when either side is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (const index of [0, 1, 2] as const) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** The version `claude --version` printed — `2.1.220 (Claude Code)` — or `undefined` when there is none to read. */
export function parseVersionOutput(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(output)?.[1];
}

/** The `latest` version from a registry answer, or `undefined` for anything that is not a stable one. */
export function parseNpmLatest(value: unknown): LatestRelease | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version = (value as { version?: unknown }).version;
  if (typeof version !== 'string' || !VersionSchema.safeParse(version).success || version.includes('-'))
    return undefined;
  return { version, url: changelogUrl() };
}

/** The latest release this check knows of, from a fresh answer or the last good one. */
export function knownLatestRelease(check: UpdateCheck): LatestRelease | undefined {
  if (check.state === 'ok') return check.latest;
  if (check.state === 'failed') return check.lastKnown?.latest;
  return undefined;
}

/**
 * Where a version stands against the one Ferretry verified. `unverified` is NEWER than that — the case that
 * needs a person's explicit yes; `older` still runs, it is simply behind what was measured.
 */
export function verification(version: string | undefined): HarnessVerification {
  if (version === undefined) return 'unknown';
  const comparison = compareVersions(version, VERIFIED_CLAUDE_CODE_VERSION);
  if (comparison === 0) return 'verified';
  if (comparison === -1) return 'older';
  return comparison === 1 ? 'unverified' : 'unknown';
}

/** Whether installing `version` goes past what Ferretry verified, which needs the person's explicit yes. */
export const needsUnverifiedConsent = (version: string | undefined): boolean => verification(version) === 'unverified';

// ─── install facts and method ────────────────────────────────────────────────────────────────────────────────────

/** Every fact {@link classifyInstall} reads, gathered by an adapter for the file a runtime launches. */
export interface InstallFacts {
  readonly launchedPath: string;
  readonly resolvedPath: string;
  readonly homeDirectory: string;
  readonly platform: string;
  readonly nixProfileElement?: string | undefined;
  readonly homeManagerProfile?: boolean | undefined;
  readonly viaHomeManagerPath?: boolean | undefined;
}

const STORE_PREFIX = '/nix/store/';
const isStorePath = (path: string): boolean => /^\/nix\/store\/[0-9a-z]{32}-[^/]+/u.test(path);
const withoutTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);
const parentDirectory = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

/** The user-level nix profile roots a stable profile path sits under. */
const userProfileRoots = (home: string): readonly string[] => {
  const base = withoutTrailingSlash(home);
  return [`${base}/.nix-profile/`, `${base}/.local/state/nix/profiles/`, '/nix/var/nix/profiles/per-user/'];
};

type NixMethod = Extract<HarnessInstallMethod, { kind: 'nix-profile' | 'nix-shell' | 'nix-module' | 'unknown' }>;

/** Whether a resolved executable lives in the Nix store, which {@link classifyNixStorePath} then decides. */
export const isNixStoreFile = (resolvedPath: string): boolean => resolvedPath.startsWith(STORE_PREFIX);

/**
 * How an executable in the Nix store was installed — decided by HOW it was reached: launched as the store
 * path itself is an ephemeral `nix shell`; reached through a system profile is a module; reached through the
 * user's profile is that profile's element, or home-manager's generation.
 */
export function classifyNixStorePath(facts: InstallFacts): NixMethod {
  const launched = facts.launchedPath;
  if (isStorePath(launched)) {
    const storePath = launched.slice(0, launched.indexOf('/', STORE_PREFIX.length));
    return { kind: 'nix-shell', storePath };
  }
  const systemManager = facts.platform === 'darwin' ? ('nix-darwin' as const) : ('nixos' as const);
  if (launched.startsWith('/etc/profiles/per-user/') && facts.viaHomeManagerPath === true)
    return { kind: 'nix-module', manager: 'home-manager', via: systemManager };
  if (launched.startsWith('/run/current-system/') || launched.startsWith('/etc/profiles/per-user/'))
    return { kind: 'nix-module', manager: systemManager };
  if (userProfileRoots(facts.homeDirectory).some(root => launched.startsWith(root))) {
    if (facts.nixProfileElement !== undefined) return { kind: 'nix-profile', element: facts.nixProfileElement };
    if (facts.homeManagerProfile === true || facts.viaHomeManagerPath === true)
      return { kind: 'nix-module', manager: 'home-manager' };
    return { kind: 'unknown', reason: 'this nix profile has no element for it; it may have come from nix-env' };
  }
  return { kind: 'unknown', reason: `${launched} leads into the Nix store by a path Ferretry does not recognise` };
}

const NODE_MANAGERS: readonly [RegExp, 'nvm' | 'fnm' | 'asdf' | 'mise'][] = [
  [/\/\.nvm\//u, 'nvm'],
  [/\/\.?fnm\//u, 'fnm'],
  [/\/\.asdf\//u, 'asdf'],
  [/\/mise\//u, 'mise'],
];

function npmGlobal(facts: InstallFacts): HarnessInstallMethod | undefined {
  const packageName = CLAUDE_CODE_PACKAGES.npm;
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
 * Decide how `claude` was installed, from the file a runtime actually launches.
 *
 * ORDER MATTERS, most certain first. A Caskroom is unambiguous. A store path is decided by HOW it was
 * reached — and it is asked BEFORE the npm layout, because nixpkgs' `claude-code` is itself a
 * `lib/node_modules/@anthropic-ai/claude-code` inside the store. Then the JavaScript globals, Homebrew
 * formulae, Claude Code's own installer, and anything else is a standalone file whose update this cannot do.
 */
export function classifyInstall(facts: InstallFacts): HarnessInstallMethod {
  const resolved = facts.resolvedPath;
  const cask = /\/Caskroom\/([^/]+)\//u.exec(resolved)?.[1];
  if (cask !== undefined) return { kind: 'homebrew', type: 'cask', package: cask };
  if (isNixStoreFile(resolved)) return classifyNixStorePath(facts);
  const npm = npmGlobal(facts);
  if (npm !== undefined) return npm;
  const formula = /\/Cellar\/([^/]+)\//u.exec(resolved)?.[1];
  if (formula !== undefined) return { kind: 'homebrew', type: 'formula', package: formula };
  const nativeRoot = `${facts.homeDirectory.replace(/\/+$/u, '')}/.local/share/claude`;
  if (resolved.startsWith(`${nativeRoot}/`)) return { kind: 'native-installer', directory: nativeRoot };
  return { kind: 'standalone', directory: parentDirectory(resolved) };
}

/** A short, plain name for each method. */
export function installLabel(method: HarnessInstallMethod): string {
  switch (method.kind) {
    case 'npm-global':
      return method.tool === 'volta' ? 'Volta' : `${method.tool} global`;
    case 'homebrew':
      return 'Homebrew';
    case 'native-installer':
      return 'Claude Code installer';
    case 'nix-profile':
      return 'nix profile';
    case 'nix-shell':
      return 'nix shell (temporary)';
    case 'nix-module':
      return 'Nix module';
    case 'standalone':
      return 'standalone binary';
    case 'unknown':
      return 'unrecognised';
  }
}

// ─── what updating takes ─────────────────────────────────────────────────────────────────────────────────────────

/** The programs an update runs. `harness` is `claude` itself (`claude update`). */
export type UpdateProgram = 'npm' | 'pnpm' | 'bun' | 'volta' | 'brew' | 'nix' | 'harness';

/** One command an update runs: a program and its arguments, never a shell string. */
export interface UpdateCommand {
  readonly program: UpdateProgram;
  readonly args: readonly string[];
}

/** A command as a person types it. */
export function commandLine(command: UpdateCommand): string {
  return [command.program === 'harness' ? 'claude' : command.program, ...command.args].join(' ');
}

/** What updating takes for one install method. */
export type UpdateRecipe =
  | {
      readonly kind: 'self';
      readonly run: readonly UpdateCommand[];
      /** Whether the method installs exactly the version asked for; Homebrew and nix take what they have. */
      readonly pinsVersion: boolean;
      /** What puts the previous version back, given it; `undefined` when the method keeps none. */
      readonly rollback: ((previous: string) => readonly UpdateCommand[]) | undefined;
    }
  | { readonly kind: 'manual'; readonly explanation: string; readonly steps: readonly UpdateStep[] };

function nodeInstall(method: Extract<HarnessInstallMethod, { kind: 'npm-global' }>, version: string): UpdateCommand {
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
 * The manual steps for anything a home-manager, nix-darwin or NixOS module installed: bump the flake input,
 * then the ONE switch command for that flavour ("home-manager inside nix-darwin has no separate switch").
 */
export function nixModuleUpdate(method: Extract<HarnessInstallMethod, { kind: 'nix-module' }>): {
  readonly explanation: string;
  readonly steps: readonly UpdateStep[];
} {
  const switcher = method.via ?? method.manager;
  const switchCommand =
    switcher === 'home-manager'
      ? 'home-manager switch --flake .'
      : switcher === 'nix-darwin'
        ? 'darwin-rebuild switch --flake .'
        : 'sudo nixos-rebuild switch --flake .';
  const inside =
    method.via === undefined
      ? 'your home-manager configuration'
      : `your home-manager configuration, which ${method.via} applies`;
  const inputNote = `the input that provides ${CLAUDE_CODE_PACKAGES.nixpkgs} is usually nixpkgs, or an overlay that packages it`;
  return {
    explanation:
      method.manager === 'home-manager'
        ? `${CLAUDE_CODE_LABEL} comes from ${inside}, which pins the version in its flake. Bump the input there, then switch.`
        : `${CLAUDE_CODE_LABEL} comes from your ${method.manager} configuration, which pins the version in its flake. Bump the input there, then switch.`,
    steps: [
      {
        command: 'nix flake update nixpkgs',
        note:
          method.via === undefined
            ? `in your configuration flake; ${inputNote}`
            : `in the flake that holds your home-manager configuration; ${inputNote}`,
      },
      method.via === undefined
        ? { command: switchCommand }
        : {
            command: switchCommand,
            note: `home-manager is applied by this ${method.via} rebuild; there is no separate home-manager switch`,
          },
    ],
  };
}

/**
 * What updating takes for this method, to `target` (`undefined` is "the newest").
 *
 * Only a method that needs no `sudo` and changes nobody's configuration is `self`: a module install is pinned
 * by somebody's flake, a temporary nix shell is gone at the next garbage collection, and a binary Ferretry did
 * not recognise is not Ferretry's to replace.
 */
export function updateRecipe(method: HarnessInstallMethod, target: string | undefined): UpdateRecipe {
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
      const update = nixModuleUpdate(method);
      return { kind: 'manual', explanation: update.explanation, steps: update.steps };
    }
    case 'nix-shell':
      return {
        kind: 'manual',
        explanation: `${CLAUDE_CODE_LABEL} here runs from a temporary nix shell store path, which never updates and which garbage collection can delete. Install it into your nix profile, and every later update is one click.`,
        steps: [{ command: `nix profile install nixpkgs#${CLAUDE_CODE_PACKAGES.nixpkgs}` }],
      };
    case 'standalone':
      return {
        kind: 'manual',
        explanation: `${CLAUDE_CODE_LABEL} here is a file in ${method.directory} that no package manager Ferretry knows owns. Reinstall it with Claude Code's own installer, and later updates are one click.`,
        steps: [{ command: 'curl -fsSL https://claude.ai/install.sh | bash' }],
      };
    case 'unknown':
      return {
        kind: 'manual',
        explanation: `Ferretry cannot update ${CLAUDE_CODE_LABEL} here: ${method.reason}.`,
        steps: [],
      };
  }
}

/** The wire shape of a recipe, as a person reads it. */
export type UpdatePlan =
  | {
      readonly kind: 'self';
      readonly steps: UpdateStep[];
      readonly rollback: 'automatic' | 'none';
      readonly pinsVersion: boolean;
    }
  | { readonly kind: 'manual'; readonly explanation: string; readonly steps: UpdateStep[] };

/** The recipe as a person reads it. */
export function updatePlan(method: HarnessInstallMethod, target: string | undefined): UpdatePlan {
  const recipe = updateRecipe(method, target);
  if (recipe.kind === 'manual') return { kind: 'manual', explanation: recipe.explanation, steps: [...recipe.steps] };
  return {
    kind: 'self',
    steps: recipe.run.map(command => ({ command: commandLine(command) })),
    rollback: recipe.rollback === undefined ? 'none' : 'automatic',
    pinsVersion: recipe.pinsVersion,
  };
}
