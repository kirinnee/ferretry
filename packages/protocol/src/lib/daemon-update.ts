/**
 * HOW THIS MACHINE'S DAEMON WAS INSTALLED, WHAT THE LATEST RELEASE IS, AND WHAT UPDATING IT TAKES.
 *
 * The daemon and `fy` both answer "how was I installed?" — the daemon for the app, `fy` for
 * `fy daemon status` and `fy daemon update`. They read the facts their own way (the daemon from its
 * own executable, `fy` from the one on `PATH`) and classify them HERE, with one pure function, so the
 * two can never disagree about what a machine is. Reading a fact is an adapter's job; nothing in this
 * module touches a file, a process or the network.
 *
 * The contract and its reasons are `docs/updating.md`.
 */

import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';
import { compareProtocolVersions, ProtocolVersionSchema } from './version-skew.ts';

/**
 * The GitHub account that publishes releases. The repository is the PRODUCT name, which callers pass
 * in from their own single source (`productName`), so a product rename carries it.
 */
export const RELEASE_OWNER = 'kirinnee';

/** At most this often the daemon asks for the latest release; also once at boot. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long a restarted daemon has to report the target version before the update rolls back. */
export const UPDATE_HEALTH_TIMEOUT_MS = 30_000;

/**
 * What a standalone release signature covers: this line, then the exact bytes of `checksums.txt`.
 *
 * The prefix is domain separation. A signature over bare `checksums.txt` bytes would be a signature
 * over whatever else those bytes could be read as; with the prefix it means this and nothing else.
 */
export const DAEMON_RELEASE_SIGNATURE_CONTEXT = 'ferretry-daemon-release-v1\n';

/** The `nix profile install` / flake reference for a product. */
export const releaseFlakeReference = (product: string): string => `github:${RELEASE_OWNER}/${product}`;

/** The Homebrew tap a product's cask lives in: this repository, named `<owner>/<product>`. */
export const releaseTapName = (product: string): string => `${RELEASE_OWNER}/${product}`;

/** Where that tap is cloned from; the tap is the whole repository, so it has no `homebrew-` prefix. */
export const releaseTapUrl = (product: string): string => `https://github.com/${RELEASE_OWNER}/${product}`;

/** The GitHub API address of a product's latest published release. */
export const latestReleaseApiUrl = (product: string): string =>
  `https://api.github.com/repos/${RELEASE_OWNER}/${product}/releases/latest`;

/** The download base of one tagged release's assets. */
export const releaseDownloadBase = (product: string, version: string): string =>
  `https://github.com/${RELEASE_OWNER}/${product}/releases/download/v${version}`;

// ---------------------------------------------------------------------------------------------------
// Install method
// ---------------------------------------------------------------------------------------------------

export const SystemPackageManagerSchema = z.enum(['apt', 'dnf', 'yum']);
export type SystemPackageManager = z.infer<typeof SystemPackageManagerSchema>;

export const NixModuleManagerSchema = z.enum(['home-manager', 'nix-darwin', 'nixos']);
export type NixModuleManager = z.infer<typeof NixModuleManagerSchema>;

/** The system-wide manager that applies a home-manager generation when home-manager runs inside it. */
export const NixSystemManagerSchema = z.enum(['nix-darwin', 'nixos']);
export type NixSystemManager = z.infer<typeof NixSystemManagerSchema>;

export const InstallMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('homebrew'), cask: z.string().min(1) }),
  z.strictObject({ kind: z.literal('nix-profile'), element: z.string().min(1) }),
  z.strictObject({ kind: z.literal('nix-shell'), storePath: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('nix-module'),
    manager: NixModuleManagerSchema,
    via: NixSystemManagerSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('system-package'), manager: SystemPackageManagerSchema }),
  z.strictObject({ kind: z.literal('standalone'), directory: z.string().min(1) }),
  z.strictObject({ kind: z.literal('unknown'), reason: z.string().min(1) }),
]);
export type InstallMethod = z.infer<typeof InstallMethodSchema>;
export type InstallMethodKind = InstallMethod['kind'];

/** Every fact `classifyInstallMethod` reads, gathered by an adapter. */
export interface InstallFacts {
  /** The product name (`ferretry`): the cask, the flake and the release repository. */
  readonly product: string;
  /** Whether the daemon is a compiled release binary rather than a development `bun …/fyd.ts`. */
  readonly compiled: boolean;
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
  /** The system package manager that owns the resolved file (`dpkg -S` / `rpm -qf`), when one does. */
  readonly systemPackage?: SystemPackageManager | undefined;
}

const STORE_PREFIX = '/nix/store/';

const isStorePath = (path: string): boolean => /^\/nix\/store\/[0-9a-z]{32}-[^/]+/u.test(path);

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

/**
 * Decide how the daemon was installed, from facts alone.
 *
 * ORDER MATTERS, and it is the order of how sure each rule is. A Homebrew Caskroom or a package
 * manager's ownership is unambiguous. A store path is then decided by HOW it was reached: launched as
 * the store path itself is an ephemeral `nix shell`; reached through a system profile is a module;
 * reached through the user's profile is that profile's element, or home-manager's generation.
 */
export function classifyInstallMethod(facts: InstallFacts): InstallMethod {
  if (!facts.compiled) return { kind: 'unknown', reason: 'this is a development build run from source' };
  const resolved = facts.resolvedPath;
  if (resolved.includes(`/Caskroom/${facts.product}/`)) return { kind: 'homebrew', cask: facts.product };
  if (facts.systemPackage !== undefined) return { kind: 'system-package', manager: facts.systemPackage };
  if (resolved.startsWith(STORE_PREFIX)) {
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
  return { kind: 'standalone', directory: parentDirectory(resolved) };
}

/** A short, plain name for each method, for a status line or a settings row. */
export const INSTALL_METHOD_LABELS: Readonly<Record<InstallMethodKind, string>> = {
  homebrew: 'Homebrew',
  'nix-profile': 'nix profile',
  'nix-shell': 'nix shell (temporary)',
  'nix-module': 'Nix module',
  'system-package': 'system package',
  standalone: 'standalone binary',
  unknown: 'unrecognised',
};

/** The label, with the detail a person needs to recognise their own install. */
export function describeInstallMethod(method: InstallMethod): string {
  switch (method.kind) {
    case 'homebrew':
      return `Homebrew cask ${method.cask}`;
    case 'nix-profile':
      return `nix profile element ${method.element}`;
    case 'nix-shell':
      return `nix shell store path ${method.storePath}`;
    case 'nix-module':
      return method.via === undefined ? `${method.manager} module` : `${method.manager} (via ${method.via}) module`;
    case 'system-package':
      return `${method.manager} package`;
    case 'standalone':
      return `standalone binary in ${method.directory}`;
    case 'unknown':
      return `unrecognised install (${method.reason})`;
  }
}

// ---------------------------------------------------------------------------------------------------
// Update plan
// ---------------------------------------------------------------------------------------------------

/** One step a person runs, or that a self-update runs for them. */
export const UpdateStepSchema = z.strictObject({
  command: z.string().min(1),
  /** Why, or where to run it, when the command alone does not say. */
  note: z.string().min(1).optional(),
});
export type UpdateStep = z.infer<typeof UpdateStepSchema>;

export const UpdatePlanSchema = z.discriminatedUnion('kind', [
  /** Ferretry can do it: one click in the app, or `fy daemon update`. */
  z.strictObject({
    kind: z.literal('self'),
    steps: z.array(UpdateStepSchema).min(1),
    /** Whether a failed health check puts the previous version back on its own. */
    rollback: z.enum(['automatic', 'none']),
  }),
  /** Ferretry can fix updates for good by changing how it is installed — only when asked. */
  z.strictObject({
    kind: z.literal('switch'),
    explanation: z.string().min(1),
    steps: z.array(UpdateStepSchema).min(1),
  }),
  /** Somebody has to do it, and these are the exact steps. */
  z.strictObject({ kind: z.literal('manual'), explanation: z.string().min(1), steps: z.array(UpdateStepSchema) }),
]);
export type UpdatePlan = z.infer<typeof UpdatePlanSchema>;

/** What `planUpdate` needs beyond the method. */
export interface UpdatePlanContext {
  readonly product: string;
  /** The client binary name (`fy`): it is what a person types. */
  readonly clientName: string;
}

/**
 * What updating takes for this install method.
 *
 * Only methods that need no `sudo` and change nobody's configuration are `self`. A module install is
 * pinned by somebody's own flake, and changing the pin is changing their configuration; a deb or rpm
 * needs root, which the daemon never asks for.
 */
export function planUpdate(method: InstallMethod, context: UpdatePlanContext): UpdatePlan {
  const restart: UpdateStep = { command: `${context.clientName} daemon restart` };
  const flake = releaseFlakeReference(context.product);
  switch (method.kind) {
    case 'homebrew':
      return {
        kind: 'self',
        steps: [{ command: `brew upgrade --cask ${method.cask}` }, restart],
        rollback: 'none',
      };
    case 'nix-profile':
      return {
        kind: 'self',
        steps: [{ command: `nix profile upgrade ${method.element}` }, restart],
        rollback: 'automatic',
      };
    case 'nix-shell':
      return {
        kind: 'switch',
        explanation:
          'This daemon runs from a temporary nix shell store path, which garbage collection can delete and which never updates. Installing it into your nix profile gives the service a stable path, and every later update is one click.',
        steps: [
          { command: `nix profile install ${flake}` },
          { command: `${context.clientName} daemon install`, note: 'from a new shell, so the profile is on PATH' },
        ],
      };
    case 'nix-module': {
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
      return {
        kind: 'manual',
        explanation:
          method.manager === 'home-manager'
            ? `This daemon comes from ${inside}, which pins the version in its flake. Bump the input there, then switch.`
            : `This daemon comes from your ${method.manager} configuration, which pins the version in its flake. Bump the input there, then switch.`,
        steps: [
          {
            command: `nix flake update ${context.product}`,
            note:
              method.via === undefined
                ? 'in your configuration flake; the input may have another name'
                : 'in the flake that holds your home-manager configuration; the input may have another name',
          },
          method.via === undefined
            ? { command: switchCommand }
            : {
                command: switchCommand,
                note: `home-manager is applied by this ${method.via} rebuild; there is no separate home-manager switch`,
              },
          restart,
        ],
      };
    }
    case 'system-package':
      return {
        kind: 'manual',
        explanation:
          'This daemon was installed by the system package manager, which needs sudo. Ferretry never asks for it.',
        steps: [
          {
            command:
              method.manager === 'apt'
                ? `sudo apt-get update && sudo apt-get install --only-upgrade ${context.clientName}`
                : `sudo ${method.manager} upgrade ${context.clientName}`,
          },
          restart,
        ],
      };
    case 'standalone':
      return {
        kind: 'self',
        steps: [
          {
            command: `${context.clientName} daemon update`,
            note: `downloads, verifies and swaps the binaries in ${method.directory}`,
          },
        ],
        rollback: 'automatic',
      };
    case 'unknown':
      return {
        kind: 'manual',
        explanation: `Ferretry cannot update this daemon: ${method.reason}.`,
        steps: [],
      };
  }
}

// ---------------------------------------------------------------------------------------------------
// Latest release
// ---------------------------------------------------------------------------------------------------

export const LatestReleaseSchema = z.strictObject({
  version: ProtocolVersionSchema,
  /** The release page, which is the changelog. */
  url: z.url(),
  publishedAt: InstantSchema.optional(),
});
export type LatestRelease = z.infer<typeof LatestReleaseSchema>;

const GitHubReleaseSchema = z.looseObject({
  tag_name: z.string(),
  html_url: z.url(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
});

/**
 * The latest release, from a GitHub `releases/latest` answer — or `undefined` for anything that is
 * not one: a draft, a prerelease, a tag that is not `v<semver>`, or a page that is not https.
 */
export function parseGitHubLatestRelease(value: unknown): LatestRelease | undefined {
  const parsed = GitHubReleaseSchema.safeParse(value);
  if (!parsed.success || parsed.data.draft === true || parsed.data.prerelease === true) return undefined;
  const version = parsed.data.tag_name.replace(/^v/u, '');
  if (!ProtocolVersionSchema.safeParse(version).success) return undefined;
  if (!parsed.data.html_url.startsWith('https://')) return undefined;
  const published = InstantSchema.safeParse(parsed.data.published_at);
  return {
    version,
    url: parsed.data.html_url,
    ...(published.success ? { publishedAt: published.data } : {}),
  };
}

/** Whether `latest` is newer than `current`. Versions that do not parse are never "newer". */
export function isUpdateAvailable(current: string, latest: LatestRelease | undefined): boolean {
  if (latest === undefined) return false;
  return compareProtocolVersions(latest.version, current) === 1;
}

// ---------------------------------------------------------------------------------------------------
// The daemon's view
// ---------------------------------------------------------------------------------------------------

export const UpdateCheckSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('never') }),
  z.strictObject({ state: z.literal('ok'), checkedAt: InstantSchema, latest: LatestReleaseSchema }),
  z.strictObject({
    state: z.literal('failed'),
    checkedAt: InstantSchema,
    reason: z.string().min(1),
    /** The last answer that worked, kept so a failed check does not hide a known update. */
    lastKnown: z.strictObject({ checkedAt: InstantSchema, latest: LatestReleaseSchema }).optional(),
  }),
]);
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;

/** The latest release this check knows of, from a fresh answer or the last good one. */
export function knownLatestRelease(check: UpdateCheck): LatestRelease | undefined {
  if (check.state === 'ok') return check.latest;
  if (check.state === 'failed') return check.lastKnown?.latest;
  return undefined;
}

export const UpdateOutcomeSchema = z.enum(['succeeded', 'rolled-back', 'failed']);
export type UpdateOutcome = z.infer<typeof UpdateOutcomeSchema>;

/**
 * What `fy daemon update --report <file>` writes when it finishes, for the NEW daemon to read.
 *
 * It is the one thing that crosses the restart: the process that started the update is gone by the
 * time it ends, so the outcome has to wait on disk for whichever daemon comes up.
 */
export const UpdateReportSchema = z.strictObject({
  from: ProtocolVersionSchema,
  target: ProtocolVersionSchema,
  outcome: UpdateOutcomeSchema,
  /** One plain sentence: what happened, and what to do if anything. */
  message: z.string().min(1),
  finishedAt: InstantSchema,
});
export type UpdateReport = z.infer<typeof UpdateReportSchema>;

export const UpdateJobSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('waiting-for-idle'),
    target: ProtocolVersionSchema,
    requestedAt: InstantSchema,
    midTurn: NonNegativeIntegerSchema,
  }),
  z.strictObject({ state: z.literal('running'), target: ProtocolVersionSchema, startedAt: InstantSchema }),
  z.strictObject({ state: z.literal('finished'), report: UpdateReportSchema }),
]);
export type UpdateJob = z.infer<typeof UpdateJobSchema>;

export const DaemonUpdateViewSchema = z.strictObject({
  current: ProtocolVersionSchema,
  method: InstallMethodSchema,
  plan: UpdatePlanSchema,
  check: UpdateCheckSchema,
  /** A newer release is known — `isUpdateAvailable(current, knownLatestRelease(check))`. */
  available: z.boolean(),
  /** Ferrets mid-turn right now; an update started `now` while this is not zero needs consent. */
  midTurn: NonNegativeIntegerSchema,
  /** "Install updates automatically when idle" — off unless somebody turned it on. */
  autoInstall: z.boolean(),
  /** The update in flight, or the last one that finished; `null` when there has been none. */
  job: UpdateJobSchema.nullable(),
});
export type DaemonUpdateView = z.infer<typeof DaemonUpdateViewSchema>;

export const DaemonUpdateStartRequestSchema = z.strictObject({
  /** The version the person saw and agreed to — refused when it is no longer the latest known. */
  target: ProtocolVersionSchema,
  when: z.enum(['now', 'when-idle']),
  /** "Update anyway": restart even though ferrets are mid-turn. Only read with `when: 'now'`. */
  confirmMidTurn: z.boolean().optional(),
});
export type DaemonUpdateStartRequest = z.infer<typeof DaemonUpdateStartRequestSchema>;

export const DaemonUpdateSettingsPatchSchema = z.strictObject({ autoInstall: z.boolean() });
export type DaemonUpdateSettingsPatch = z.infer<typeof DaemonUpdateSettingsPatchSchema>;

/** Refusal codes the update routes answer with, so the app can say the right sentence. */
export const DAEMON_UPDATE_CODES = {
  midTurn: 'update_mid_turn',
  inProgress: 'update_in_progress',
  notAvailable: 'update_not_available',
  notSelfUpdatable: 'update_not_self_updatable',
  staleTarget: 'update_stale_target',
} as const;

/** The `409 update_mid_turn` body: how many ferrets would be interrupted. */
export const DaemonUpdateMidTurnBodySchema = z.looseObject({
  error: z.string(),
  code: z.literal(DAEMON_UPDATE_CODES.midTurn),
  midTurn: NonNegativeIntegerSchema,
});
export type DaemonUpdateMidTurnBody = z.infer<typeof DaemonUpdateMidTurnBodySchema>;

// ---------------------------------------------------------------------------------------------------
// Reading `nix profile list --json`
// ---------------------------------------------------------------------------------------------------

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

const HOME_MANAGER_PATH = /^\/nix\/store\/[0-9a-z]{32}-home-manager-path(?:\/|$)/u;
const isHomeManagerPath = (storePath: string): boolean => /-home-manager-path$/u.test(storePath);

/**
 * The profile element that holds the executable, from `nix profile list --json`.
 *
 * `candidates` is every store path the launched path leads through — the first hop out of the profile
 * AND the final resolved file. A package that is itself a symbolic-link join (`<hash>-ferretry/bin/fyd`
 * → `<hash>-fyd-4.31.0/bin/fyd`) is held by the element under its OUTER path, which the resolved file
 * is not under. The home-manager element is never "the element": it is what `homeManager` reports.
 *
 * Both shapes Nix has shipped are read: version 3 keys elements by NAME, which is what
 * `nix profile upgrade` takes; version 2 is an array, whose INDEX is what an older `nix profile
 * upgrade` takes. Anything that is not either answers "no element", never a guess.
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
    name === 'home-manager-path' || (entry.storePaths ?? []).some(isHomeManagerPath);
  const element = entries.find(entry => !isHomeManager(entry) && (entry[1].storePaths ?? []).some(holds))?.[0];
  return { element, homeManager: entries.some(isHomeManager) };
}

// ---------------------------------------------------------------------------------------------------
// Reading the symbolic-link chain
// ---------------------------------------------------------------------------------------------------

/** Link hops are capped at the kernel's own limit, so a loop ends instead of spinning. */
const MAX_LINK_HOPS = 40;

/**
 * Every symbolic link met on the way from `path` to the file it names, each as an absolute target.
 *
 * `readLink` answers a link's target, or `undefined` when the path is not a link (or is not there):
 * the filesystem stays the adapter's, so this stays pure. Directory links count — `~/.nix-profile/bin`
 * is often itself a link into a store path — so the walk goes component by component.
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
export const storePathHops = (hops: readonly string[]): readonly string[] => hops.filter(isStorePath);

/** Whether a link chain passes through a `home-manager-path` store path — home-manager's own generation. */
export const passesThroughHomeManagerPath = (hops: readonly string[]): boolean =>
  hops.some(hop => HOME_MANAGER_PATH.test(hop));
