/**
 * What installing a catalog item would make the installer's machine RUN or FOLLOW, in words
 * (docs/catalogs.md § Install is a trust step).
 *
 * A skill is instructions a ferret follows — scripts included, when it runs unattended — and an MCP
 * setup is a program the installer's runtimes start. Nothing makes either safe; the design makes it
 * VISIBLE, DELIBERATE and PINNED. This module is the visible part: every file in full and every command
 * line, never a count, plus the warnings a person should read before saying yes.
 *
 * ONE OWNER, TWO READERS. The installer's daemon answers its preview from these functions, and the app
 * and `fy` show what it answered, so the screen and the write can never disagree. As in Clone's review
 * (`fleet-clone-review.ts`), nothing is hidden: the publisher chose every name, so a value under a
 * secret-sounding name is shown rather than masked — a catalog never carries a secret VALUE, only
 * `${secret:NAME}` placeholders the installer fills from their own store.
 *
 * Pure and total over items {@link SharedCatalogItemSchema} accepted.
 */
import { z } from 'zod';
import { commandLine } from './fleet-clone-review.ts';
import { CATALOG_SKILL_ENTRY_FILE, type CatalogMcpSetup, type SharedCatalogItem } from './shared-catalog.ts';

/** One thing an item brings, in words. */
export const CatalogReviewEntrySchema = z.strictObject({
  /** What it is: "Starts", "Reaches", "Environment GITHUB_TOKEN", "Skill file SKILL.md". */
  label: z.string().min(1),
  /** Exactly what the publisher published: the command line, the value, or a whole file. */
  text: z.string(),
  /** A whole document rather than one line, so a reader shows it as a block. */
  document: z.boolean(),
});
export type CatalogReviewEntry = z.infer<typeof CatalogReviewEntrySchema>;

export const CATALOG_INSTALL_WARNING_CODES = [
  /** A package manager fetches whatever is newest at launch: this item can change without an update. */
  'unpinned-package',
  /** A server at an address runs on someone else's computer and can change at any time. */
  'network-url',
  /** A skill carries scripts a ferret may run. */
  'carries-scripts',
  /** The person chose an older version than the one installed. */
  'older-version',
  /** The installed copy was changed on this machine since it was installed (phase 3). */
  'edited-locally',
  /** The first install from this publisher: its fingerprint is pinned from now on. */
  'first-publisher',
] as const;
export const CatalogInstallWarningCodeSchema = z.enum(CATALOG_INSTALL_WARNING_CODES);
export type CatalogInstallWarningCode = z.infer<typeof CatalogInstallWarningCodeSchema>;

export const CatalogInstallWarningSchema = z.strictObject({
  code: CatalogInstallWarningCodeSchema,
  text: z.string().min(1),
});
export type CatalogInstallWarning = z.infer<typeof CatalogInstallWarningSchema>;

// ── Every file and every command ─────────────────────────────────────────────────────────────────

/** `SKILL.md` first, then every other file by path, each in full. Paths are unique (the schema says so). */
const skillEntries = (files: readonly { readonly path: string; readonly content: string }[]): CatalogReviewEntry[] =>
  [
    ...files.filter(file => file.path === CATALOG_SKILL_ENTRY_FILE),
    ...files
      .filter(file => file.path !== CATALOG_SKILL_ENTRY_FILE)
      .toSorted((left, right) => (left.path < right.path ? -1 : 1)),
  ].map(file => ({ label: `Skill file ${file.path}`, text: file.content, document: true }));

const mcpEntries = (setup: CatalogMcpSetup): CatalogReviewEntry[] => {
  if (setup.transport === 'url') {
    return [
      { label: 'Reaches', text: setup.url, document: false },
      ...(setup.auth === 'oauth'
        ? [
            {
              label: 'Signs in',
              text: 'You sign in to it yourself, on your machine. No token is copied.',
              document: false,
            },
          ]
        : []),
      ...(setup.oauth === undefined ? [] : [{ label: 'Sign-in client', text: setup.oauth.clientId, document: false }]),
    ];
  }
  return [
    { label: 'Starts', text: commandLine(setup.command, setup.args), document: false },
    ...Object.keys(setup.env)
      .toSorted()
      .map(name => ({ label: `Environment ${name}`, text: setup.env[name] ?? '', document: false })),
  ];
};

/** Everything an item brings, in a fixed order, so two readers list it identically. */
export function catalogItemReview(item: SharedCatalogItem): readonly CatalogReviewEntry[] {
  switch (item.kind) {
    case 'skill':
      return skillEntries(item.skill.files);
    case 'mcp':
      return mcpEntries(item.mcp);
    case 'artifact':
      return [
        { label: 'Opens', text: `A ${item.artifact.mediaType} file of ${item.artifact.size} bytes`, document: false },
      ];
  }
}

// ── Unpinned packages ────────────────────────────────────────────────────────────────────────────

/** What fetches a package at launch, and the package it would fetch. */
export interface UnpinnedPackage {
  /** The launcher as the setup spelled it: `npx`, `uvx`, `pnpm dlx`, `docker run`… */
  readonly launcher: string;
  /** The package, image or tool as written, without a version, so a sentence can name it. */
  readonly target: string;
}

/** The last path segment of a command, without a Windows `.exe`/`.cmd`. */
const programName = (command: string): string =>
  (command.split(/[/\\]/u).at(-1) ?? command).replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase();

/** An exact npm version: `1.2.3`, `1.2.3-beta.1`, `1.2.3+build`. A range or a tag is not. */
const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** `@scope/name@1.2.3` or `name@1.2.3` → the version part, or `undefined` when none is written. */
const npmVersion = (spec: string): string | undefined => {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at === -1 ? undefined : spec.slice(at + 1);
};

const npmName = (spec: string): string => {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
};

/**
 * A spec a package manager resolves to a FIXED thing: an exact version, a local path, or a git commit.
 * A tag (`latest`, `next`), a range (`^1`, `~1.2`, `1.x`, `>=1`) or nothing at all resolves to whatever
 * is newest when the ferret starts.
 */
const npmPinned = (spec: string): boolean => {
  if (/^(?:\.{0,2}\/|file:)/u.test(spec)) return true;
  if (/^(?:git\+|github:|https?:)/u.test(spec)) return /#[0-9a-f]{40}$/u.test(spec);
  const version = npmVersion(spec);
  return version !== undefined && EXACT_SEMVER.test(version);
};

/** Python: `name==1.2.3` (pip, uvx, pipx) or `name@1.2.3` (uvx). `>=`, `~=` and no version are not pinned. */
const pythonPinned = (spec: string): boolean => {
  if (/^(?:\.{0,2}\/|file:)/u.test(spec)) return true;
  if (/^git\+/u.test(spec)) return /@[0-9a-f]{40}$/u.test(spec);
  const exact = /^[A-Za-z0-9._-]+(?:\[[^\]]*\])?(?:==|@)(.+)$/u.exec(spec);
  return exact !== null && /^[0-9][0-9A-Za-z.+!-]*$/u.test(exact[1] ?? '') && exact[1] !== 'latest';
};

const pythonName = (spec: string): string => spec.split(/==|@|>=|<=|~=|!=|>|<|\[/u)[0] ?? spec;

/** A container image is fixed only by digest. A missing tag or `latest` moves; any other tag can be re-pushed. */
const imageMoves = (image: string): boolean => {
  if (image.includes('@sha256:')) return false;
  const lastSegment = image.split('/').at(-1) ?? image;
  const colon = lastSegment.lastIndexOf(':');
  return colon === -1 || lastSegment.slice(colon + 1) === 'latest';
};

/** The first argument that is not a flag, skipping a flag's own value for flags known to take one. */
const firstOperand = (
  args: readonly string[],
  valued: ReadonlySet<string>,
): { index: number; value: string } | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') return index + 1 < args.length ? { index: index + 1, value: args[index + 1] ?? '' } : undefined;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valued.has(arg)) index += 1;
      continue;
    }
    return { index, value: arg };
  }
  return undefined;
};

/** The value of `--flag value` or `--flag=value`, for any of `flags`. */
const flagValue = (args: readonly string[], flags: readonly string[]): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    for (const flag of flags) {
      if (arg === flag) return args[index + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return undefined;
};

const NPX_VALUED = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig']);
const UVX_VALUED = new Set(['--from', '--with', '-w', '--python', '-p', '--index', '--index-url', '--extra-index-url']);
const DOCKER_VALUED = new Set([
  '-e',
  '--env',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--name',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '--network',
  '--env-file',
  '--entrypoint',
  '--mount',
  '--platform',
  '-l',
  '--label',
  '--add-host',
  '--cpus',
  '-m',
  '--memory',
]);

const npmLike = (launcher: string, args: readonly string[]): UnpinnedPackage | null => {
  const packaged = flagValue(args, ['-p', '--package']);
  const spec = packaged ?? firstOperand(args, NPX_VALUED)?.value;
  if (spec === undefined || npmPinned(spec)) return null;
  return { launcher, target: npmName(spec) };
};

const pythonLike = (launcher: string, args: readonly string[]): UnpinnedPackage | null => {
  const from = flagValue(args, ['--from', '--spec']);
  const spec = from ?? firstOperand(args, UVX_VALUED)?.value;
  if (spec === undefined || pythonPinned(spec)) return null;
  return { launcher, target: pythonName(spec) };
};

/**
 * Whether this command line downloads what it runs at every launch without naming a fixed version
 * (gap G6, owner decision Q15: warned, not refused). Recognises npx, bunx, `npm exec`, `pnpm dlx`/`pnpx`,
 * `yarn dlx`, uvx, `uv tool run`, `pipx run`, and `docker`/`podman run`. Anything else is a program
 * already on the machine, which the review shows by its command line.
 */
export function unpinnedPackage(command: string, args: readonly string[]): UnpinnedPackage | null {
  const program = programName(command);
  switch (program) {
    case 'npx':
    case 'bunx':
    case 'pnpx':
      return npmLike(program, args);
    case 'npm':
      return args[0] === 'exec' || args[0] === 'x' ? npmLike(`npm ${args[0]}`, args.slice(1)) : null;
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return args[0] === 'dlx' || (program === 'bun' && args[0] === 'x')
        ? npmLike(`${program} ${args[0]}`, args.slice(1))
        : null;
    case 'uvx':
      return pythonLike('uvx', args);
    case 'uv':
      return args[0] === 'tool' && args[1] === 'run' ? pythonLike('uv tool run', args.slice(2)) : null;
    case 'pipx':
      return args[0] === 'run' ? pythonLike('pipx run', args.slice(1)) : null;
    case 'docker':
    case 'podman': {
      if (args[0] !== 'run') return null;
      const image = firstOperand(args.slice(1), DOCKER_VALUED)?.value;
      return image !== undefined && imageMoves(image) ? { launcher: `${program} run`, target: image } : null;
    }
    default:
      return null;
  }
}

// ── Warnings ─────────────────────────────────────────────────────────────────────────────────────

/** A file a ferret could run rather than read: a script by extension, or anything with a `#!` line. */
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|lua)$/iu;
const isScript = (file: { readonly path: string; readonly content: string }): boolean =>
  SCRIPT_EXTENSION.test(file.path) || file.content.startsWith('#!');

/**
 * What a person must read before installing this item, from the item alone. The installer adds the
 * warnings only it can know (`first-publisher`, `older-version`, `edited-locally`).
 */
export function catalogItemWarnings(item: SharedCatalogItem): readonly CatalogInstallWarning[] {
  if (item.kind === 'skill') {
    const scripts = item.skill.files.filter(isScript).map(file => file.path);
    return scripts.length === 0
      ? []
      : [
          {
            code: 'carries-scripts',
            text: `This skill carries ${scripts.length === 1 ? 'a script' : `${scripts.length} scripts`} a ferret may run: ${scripts.join(', ')}. Read ${scripts.length === 1 ? 'it' : 'them'} before installing.`,
          },
        ];
  }
  if (item.kind !== 'mcp') return [];
  const setup = item.mcp;
  if (setup.transport === 'url') {
    return [
      {
        code: 'network-url',
        text: `This server runs on someone else's computer, at ${setup.url}. What it does can change at any time, without an update here.`,
      },
    ];
  }
  const unpinned = unpinnedPackage(setup.command, setup.args);
  return unpinned === null
    ? []
    : [
        {
          code: 'unpinned-package',
          text: `${unpinned.launcher} ${unpinned.target} has no fixed version. It runs whatever is newest each time a ferret starts, so it can change without an update.`,
        },
      ];
}
