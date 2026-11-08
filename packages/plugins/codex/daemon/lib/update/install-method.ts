/**
 * HOW THIS MACHINE'S `codex` WAS INSTALLED.
 *
 * The daemon's own update answers "how was this executable installed?" for itself. A harness is the same question
 * about a different file, so this reads the same facts — the link chain, the nix profile listing, the store-path rule —
 * and adds only what Codex has and the daemon does not: npm-style globals and Homebrew formulae. Codex has no native
 * installer of its own, so that method does not exist here.
 *
 * Pure: reading a fact, running a package manager and asking the registry are the adapters'.
 */
import { z } from 'zod';
import type { HarnessInstallMethod } from '../../../contract/index.ts';
import { CODEX_PACKAGES } from './version.ts';

type NixSystemManager = 'nix-darwin' | 'nixos';
type NodeVersionManager = 'nvm' | 'fnm' | 'asdf' | 'mise';

/** Every fact {@link classifyCodexInstall} reads, gathered by an adapter for the file a runtime launches. */
export interface InstallFacts {
  /** The executable's path as it was launched or found on `PATH` — symbolic links NOT resolved. */
  readonly launchedPath: string;
  /** The same path with every symbolic link resolved. */
  readonly resolvedPath: string;
  readonly homeDirectory: string;
  readonly platform: 'darwin' | 'linux' | (string & {});
  /** The `nix profile` element whose store paths contain the resolved path, when one does. */
  readonly nixProfileElement?: string | undefined;
  /** Whether the user's nix profile is a home-manager generation (`home-manager-path` element). */
  readonly homeManagerProfile?: boolean | undefined;
  /** Whether the launched path's symbolic-link chain passes through a `home-manager-path` store path. */
  readonly viaHomeManagerPath?: boolean | undefined;
}

const STORE_PREFIX = '/nix/store/';
const isStorePath = (path: string): boolean => /^\/nix\/store\/[0-9a-z]{32}-[^/]+/u.test(path);
const isHomeManagerStorePath = (storePath: string): boolean => /-home-manager-path$/u.test(storePath);
const HOME_MANAGER_PATH = /^\/nix\/store\/[0-9a-z]{32}-home-manager-path(?:\/|$)/u;

const parentDirectory = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};
const withoutTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);

/** The user-level nix profile roots a stable profile path sits under. */
const userProfileRoots = (home: string): readonly string[] => {
  const base = withoutTrailingSlash(home);
  return [`${base}/.nix-profile/`, `${base}/.local/state/nix/profiles/`, '/nix/var/nix/profiles/per-user/'];
};

/** Whether a resolved executable lives in the Nix store, which {@link classifyNixStorePath} then decides. */
const isNixStoreFile = (resolvedPath: string): boolean => resolvedPath.startsWith(STORE_PREFIX);

type NixInstallMethod = Extract<HarnessInstallMethod, { kind: 'nix-profile' | 'nix-shell' | 'nix-module' | 'unknown' }>;

/**
 * How an executable in the Nix store was installed — decided by HOW it was reached: launched as the store path itself
 * is an ephemeral `nix shell`; reached through a system profile is a module; reached through the user's profile is that
 * profile's element, or home-manager's generation.
 */
function classifyNixStorePath(facts: InstallFacts): NixInstallMethod {
  const launched = facts.launchedPath;
  if (isStorePath(launched)) {
    const storePath = launched.slice(0, launched.indexOf('/', STORE_PREFIX.length));
    return { kind: 'nix-shell', storePath };
  }
  const systemManager: NixSystemManager = facts.platform === 'darwin' ? 'nix-darwin' : 'nixos';
  if (launched.startsWith('/etc/profiles/per-user/') && facts.viaHomeManagerPath === true) {
    return { kind: 'nix-module', manager: 'home-manager', via: systemManager };
  }
  if (launched.startsWith('/run/current-system/') || launched.startsWith('/etc/profiles/per-user/')) {
    return { kind: 'nix-module', manager: systemManager };
  }
  if (userProfileRoots(facts.homeDirectory).some(root => launched.startsWith(root))) {
    if (facts.nixProfileElement !== undefined) return { kind: 'nix-profile', element: facts.nixProfileElement };
    if (facts.homeManagerProfile === true || facts.viaHomeManagerPath === true) {
      return { kind: 'nix-module', manager: 'home-manager' };
    }
    return { kind: 'unknown', reason: 'this nix profile has no element for it; it may have come from nix-env' };
  }
  return { kind: 'unknown', reason: `${launched} leads into the Nix store by a path Ferretry does not recognise` };
}

const NODE_MANAGERS: readonly [RegExp, NodeVersionManager][] = [
  [/\/\.nvm\//u, 'nvm'],
  [/\/\.?fnm\//u, 'fnm'],
  [/\/\.asdf\//u, 'asdf'],
  [/\/mise\//u, 'mise'],
];

function npmGlobal(facts: InstallFacts): HarnessInstallMethod | undefined {
  const packageName = CODEX_PACKAGES.npm;
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
 * Decide how Codex was installed, from the file a runtime actually launches.
 *
 * ORDER MATTERS, most certain first. A Caskroom is unambiguous. A store path is decided by HOW it was reached, exactly
 * as the daemon's own is — and it is asked BEFORE the npm layout, because nixpkgs' `codex` may itself sit in a
 * `lib/node_modules/@openai/codex` inside the store. Then the JavaScript globals, Homebrew formulae, and anything else
 * is a standalone file whose update this cannot do.
 */
export function classifyCodexInstall(facts: InstallFacts): HarnessInstallMethod {
  const resolved = facts.resolvedPath;
  const cask = /\/Caskroom\/([^/]+)\//u.exec(resolved)?.[1];
  if (cask !== undefined) return { kind: 'homebrew', type: 'cask', package: cask };
  if (isNixStoreFile(resolved)) return classifyNixStorePath(facts);
  const npm = npmGlobal(facts);
  if (npm !== undefined) return npm;
  const formula = /\/Cellar\/([^/]+)\//u.exec(resolved)?.[1];
  if (formula !== undefined) return { kind: 'homebrew', type: 'formula', package: formula };
  return { kind: 'standalone', directory: parentDirectory(resolved) };
}

const INSTALL_LABELS = {
  'nix-profile': 'nix profile',
  'nix-shell': 'nix shell (temporary)',
  'nix-module': 'Nix module',
  standalone: 'standalone binary',
  unknown: 'unrecognised',
} as const;

/** A short, plain name for each method. */
export function harnessInstallLabel(method: HarnessInstallMethod): string {
  switch (method.kind) {
    case 'npm-global':
      return method.tool === 'volta' ? 'Volta' : `${method.tool} global`;
    case 'homebrew':
      return 'Homebrew';
    case 'nix-profile':
    case 'nix-shell':
    case 'nix-module':
    case 'standalone':
    case 'unknown':
      return INSTALL_LABELS[method.kind];
  }
}

// ─── the nix profile listing and the link chain ──────────────────────────────────────────────────────────────

const NixProfileElementSchema = z.looseObject({ storePaths: z.array(z.string()).optional() });
const NixProfileListSchema = z.looseObject({
  elements: z.union([z.record(z.string(), NixProfileElementSchema), z.array(NixProfileElementSchema)]),
});

/** What a nix profile says about one executable. */
export interface NixProfileFacts {
  /** The element whose store paths lead to the executable, as `nix profile upgrade` names it. */
  readonly element?: string | undefined;
  /** Whether the profile is a home-manager generation. */
  readonly homeManager: boolean;
}

/**
 * The profile element that holds the executable, from `nix profile list --json`.
 *
 * `candidates` is every store path the launched path leads through — the first hop out of the profile AND the final
 * resolved file. The home-manager element is never 'the element': it is what `homeManager` reports. Both shapes Nix has
 * shipped are read: version 3 keys elements by NAME, version 2 is an array, whose INDEX is what an older `nix profile
 * upgrade` takes. Anything that is not either answers 'no element', never a guess.
 */
export function parseNixProfileList(value: unknown, candidates: readonly string[]): NixProfileFacts {
  const parsed = NixProfileListSchema.safeParse(value);
  if (!parsed.success) return { homeManager: false };
  const entries: [string, z.infer<typeof NixProfileElementSchema>][] = Array.isArray(parsed.data.elements)
    ? parsed.data.elements.map((element, index) => [String(index), element])
    : Object.entries(parsed.data.elements);
  const holds = (storePath: string): boolean =>
    candidates.some(path => path === storePath || path.startsWith(`${storePath}/`));
  const isHomeManager = ([name, entry]: [string, z.infer<typeof NixProfileElementSchema>]): boolean =>
    name === 'home-manager-path' || (entry.storePaths ?? []).some(isHomeManagerStorePath);
  const element = entries.find(entry => !isHomeManager(entry) && (entry[1].storePaths ?? []).some(holds))?.[0];
  return { element, homeManager: entries.some(isHomeManager) };
}

/** Link hops are capped at the kernel's own limit, so a loop ends instead of spinning. */
const MAX_LINK_HOPS = 40;

/**
 * Every symbolic link met on the way from `path` to the file it names, each as an absolute target.
 *
 * `readLink` answers a link's target, or `undefined` when the path is not a link (or is not there): the file system
 * stays the adapter's, so this stays pure. Directory links count — `~/.nix-profile/bin` is often itself a link into a
 * store path — so the walk goes component by component.
 */
export async function symlinkHops(
  path: string,
  readLink: (path: string) => Promise<string | undefined>,
): Promise<readonly string[]> {
  const hops: string[] = [];
  let pending = path.split('/').filter(part => part !== '');
  let resolved = '';
  while (pending.length > 0 && hops.length < MAX_LINK_HOPS) {
    const [name = '', ...rest] = pending;
    pending = rest;
    if (name === '.') continue;
    if (name === '..') {
      resolved = parentDirectory(resolved) === '/' ? '' : parentDirectory(resolved);
      continue;
    }
    const candidate = `${resolved}/${name}`;
    const target = await readLink(candidate);
    if (target === undefined) {
      resolved = candidate;
      continue;
    }
    const absolute = target.startsWith('/') ? target : `${resolved}/${target}`;
    hops.push(absolute);
    pending = [...absolute.split('/').filter(part => part !== ''), ...pending];
    resolved = '';
  }
  return hops;
}

/** The store paths a link chain leads through, in order. */
export const nixPathHops = (hops: readonly string[]): readonly string[] => hops.filter(isStorePath);

/** Whether a link chain passes through a `home-manager-path` store path — home-manager's own generation. */
export const passesThroughHomeManagerPath = (hops: readonly string[]): boolean =>
  hops.some(hop => HOME_MANAGER_PATH.test(hop));

// ─── the manual steps of a module install ───────────────────────────────────────────────────────────────────

export interface UpdateStep {
  readonly command: string;
  readonly note?: string;
}

/**
 * The manual steps for anything a home-manager, nix-darwin or NixOS module installed: bump the flake input, then the ONE
 * switch command for that flavour. The 'home-manager inside nix-darwin has no separate switch' rule is written once.
 */
export function nixModuleUpdate(
  method: Extract<HarnessInstallMethod, { kind: 'nix-module' }>,
  context: { readonly subject: string; readonly input: string; readonly inputNote?: string },
): { readonly explanation: string; readonly steps: readonly UpdateStep[] } {
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
  const inputNote = context.inputNote ?? 'the input may have another name';
  return {
    explanation:
      method.manager === 'home-manager'
        ? `${context.subject} comes from ${inside}, which pins the version in its flake. Bump the input there, then switch.`
        : `${context.subject} comes from your ${method.manager} configuration, which pins the version in its flake. Bump the input there, then switch.`,
    steps: [
      {
        command: `nix flake update ${context.input}`,
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
