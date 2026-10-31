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
import {
  CATALOG_SKILL_ENTRY_FILE,
  HIDDEN_CHARACTER_SOURCE,
  holdsRawKey,
  type CatalogMcpSetup,
  type SharedCatalogItem,
} from './shared-catalog.ts';

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
  /** It fetches packages from a registry other than the public one, which can serve anything for a version. */
  'package-registry',
  /** A skill carries files a tool runs or obeys on its own when it opens the folder. */
  'runs-on-its-own',
  /** A carried file holds invisible or text-direction characters; the review shows each one marked. */
  'hidden-characters',
  /** A skill file holds what looks like a raw key. It may be an example, but it is a credential if it is not. */
  'possible-secret',
] as const;
export const CatalogInstallWarningCodeSchema = z.enum(CATALOG_INSTALL_WARNING_CODES);
export type CatalogInstallWarningCode = z.infer<typeof CatalogInstallWarningCodeSchema>;

export const CatalogInstallWarningSchema = z.strictObject({
  code: CatalogInstallWarningCodeSchema,
  text: z.string().min(1),
});
export type CatalogInstallWarning = z.infer<typeof CatalogInstallWarningSchema>;

// ── Every file and every command ─────────────────────────────────────────────────────────────────

/**
 * Invisible and text-direction characters, and controls other than a tab, a line break and a carriage
 * return that ends a line — a fresh global matcher each time, since `lastIndex` is state.
 */
const hiddenCharacters = (): RegExp =>
  // A carriage return is fine before a line feed (a Windows line ending) and hidden anywhere else: in a
  // terminal `rm -rf ~ #\recho hi` shows as `echo hi`.
  new RegExp(
    String.raw`(?:[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F${HIDDEN_CHARACTER_SOURCE}]|\r(?!\n))`,
    'gu',
  );

/**
 * A file's text with each hidden character written as `⟨U+202E⟩`, so the review shows what the file
 * holds rather than what it makes the screen look like (Trojan Source). The install writes the bytes as
 * published; only what a person reads is marked.
 */
export const revealHidden = (text: string): string =>
  text.replace(
    hiddenCharacters(),
    character => `⟨U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );

/** `SKILL.md` first, then every other file by path, each in full. Paths are unique (the schema says so). */
const skillEntries = (files: readonly { readonly path: string; readonly content: string }[]): CatalogReviewEntry[] =>
  [
    ...files.filter(file => file.path === CATALOG_SKILL_ENTRY_FILE),
    ...files
      .filter(file => file.path !== CATALOG_SKILL_ENTRY_FILE)
      .toSorted((left, right) => (left.path < right.path ? -1 : 1)),
  ].map(file => ({ label: `Skill file ${file.path}`, text: revealHidden(file.content), document: true }));

/** A value that holds a line break or a tab is shown quoted, so it cannot draw a review line of its own. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding a control character is the point.
const oneLine = (value: string): string => (/[\u0000-\u001F\u007F]/u.test(value) ? JSON.stringify(value) : value);

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
      .map(name => ({ label: `Environment ${name}`, text: oneLine(setup.env[name] ?? ''), document: false })),
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

// ── Packages fetched at launch ───────────────────────────────────────────────────────────────────

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

/** An exact version: `1.2.3`, `v1.2.3`, `1.2.3-beta.1`, `1.2.3+build`. A range or a tag is not. */
const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** `name@1.2.3` or `@scope/name@1.2.3` → its two halves; the version is `undefined` when none is written. */
const splitAt = (spec: string): { readonly name: string; readonly version: string | undefined } => {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at === -1 ? { name: spec, version: undefined } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
};

const LOCAL_PATH = /^(?:\.{0,2}\/|file:)/u;

/**
 * An npm spec that resolves to a FIXED thing: an exact version, a local path, or a git commit. A tag
 * (`latest`, `next`), a range (`^1`, `~1.2`, `1.x`, `>=1`) or nothing at all resolves to whatever is
 * newest when the ferret starts.
 */
const npmPinned = (spec: string): boolean => {
  if (LOCAL_PATH.test(spec)) return true;
  if (/^(?:git\+|github:|https?:)/u.test(spec)) return /#[0-9a-f]{40}$/u.test(spec);
  const { version } = splitAt(spec);
  return version !== undefined && EXACT_SEMVER.test(version);
};

/** Python: `name==1.2.3` (pip, uvx, pipx) or `name@1.2.3` (uvx). `>=`, `~=` and no version are not pinned. */
const pythonPinned = (spec: string): boolean => {
  if (LOCAL_PATH.test(spec)) return true;
  if (/^git\+/u.test(spec)) return /@[0-9a-f]{40}$/u.test(spec);
  const exact = /^[A-Za-z0-9._-]+(?:\[[^\]]*\])?(?:==|@)(.+)$/u.exec(spec);
  return exact !== null && /^[0-9][0-9A-Za-z.+!-]*$/u.test(exact[1] ?? '');
};

const pythonName = (spec: string): string => spec.split(/==|@|>=|<=|~=|!=|>|<|\[/u)[0] ?? spec;

/** Every value of `--flag value` or `--flag=value`, for any of `flags`. */
const flagValues = (args: readonly string[], flags: readonly string[]): readonly string[] => {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    for (const flag of flags) {
      if (arg === flag && index + 1 < args.length) values.push(args[index + 1] ?? '');
      else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
};

/** The arguments after the leading flags, skipping each flag's own value for flags known to take one. */
const operands = (args: readonly string[], valued: ReadonlySet<string>): readonly string[] => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') return args.slice(index + 1);
    if (!arg.startsWith('-')) return args.slice(index);
    if (!arg.includes('=') && valued.has(arg)) index += 1;
  }
  return [];
};

const NPX_VALUED = new Set([
  '-p',
  '--package',
  '-c',
  '--call',
  '--registry',
  '--cache',
  '--userconfig',
  '--prefix',
  '-w',
  '--workspace',
]);
const UV_VALUED = new Set([
  '--from',
  '--with',
  '-w',
  '--with-requirements',
  '--with-editable',
  '--python',
  '-p',
  '--index',
  '--index-url',
  '--default-index',
  '--extra-index-url',
  '--find-links',
  '-f',
  '--index-strategy',
  '--cache-dir',
  '--directory',
  '--project',
  '--spec',
  '--config-file',
]);
const DOCKER_VALUED = new Set([
  '-a',
  '--attach',
  '--add-host',
  '--cap-add',
  '--cap-drop',
  '--cgroupns',
  '--cidfile',
  '--cpu-shares',
  '-c',
  '--cpus',
  '--cpuset-cpus',
  '--device',
  '--dns',
  '-e',
  '--env',
  '--env-file',
  '--entrypoint',
  '--expose',
  '--gpus',
  '--group-add',
  '-h',
  '--hostname',
  '--health-cmd',
  '--ip',
  '--ipc',
  '-l',
  '--label',
  '--label-file',
  '--link',
  '--log-driver',
  '--log-opt',
  '--mac-address',
  '-m',
  '--memory',
  '--memory-swap',
  '--mount',
  '--name',
  '--network',
  '--network-alias',
  '-p',
  '--publish',
  '--pid',
  '--platform',
  '--pull',
  '--restart',
  '--runtime',
  '--security-opt',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--tmpfs',
  '-u',
  '--user',
  '--ulimit',
  '--userns',
  '--uts',
  '-v',
  '--volume',
  '--volumes-from',
  '-w',
  '--workdir',
]);
const DOCKER_GLOBAL_VALUED = new Set([
  '--context',
  '-c',
  '--host',
  '-H',
  '--config',
  '--log-level',
  '-l',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
]);
const ENV_VALUED = new Set(['-u', '--unset', '-C', '--chdir']);
const DENO_VALUED = new Set(['-c', '--config', '--lock', '--import-map', '--cert', '--location', '--seed']);

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/**
 * The command line a shell is asked to run, or `undefined` when it runs none. A POSIX shell takes the ONE
 * argument after `-c` (also combined, `-lc`, `-ec`); `cmd /c` and `powershell -Command` take the REST of
 * the arguments, which is how a Windows MCP setup usually spells `cmd /c npx -y pkg`.
 */
const shellLine = (program: string, args: readonly string[]): string | undefined => {
  if (POSIX_SHELLS.has(program)) {
    const at = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg));
    return at === -1 ? undefined : args[at + 1];
  }
  const flag =
    program === 'cmd' ? /^\/[ck]$/iu : program === 'powershell' || program === 'pwsh' ? /^-(?:c|command)$/iu : null;
  const at = flag === null ? -1 : args.findIndex(arg => flag.test(arg));
  return at === -1 ? undefined : args.slice(at + 1).join(' ');
};

/** The simple commands in a shell string: split on `&&`, `||`, `;` and `|`, then on spaces, quotes dropped. */
const shellCommands = (line: string): readonly (readonly string[])[] =>
  line
    .split(/&&|\|\||[;|]/u)
    .map(part =>
      part
        .trim()
        .split(/\s+/u)
        .map(word => word.replace(/^["']|["']$/gu, ''))
        .filter(word => word !== ''),
    )
    .filter(words => words.length > 0);

/**
 * A registry or index other than the public one, a proxy, or a change to which servers are trusted:
 * each lets someone serve different bytes for the same version.
 */
const REGISTRY_FLAGS = [
  '--userconfig',
  '--registry',
  '--index-url',
  '--extra-index-url',
  '--index',
  '--default-index',
  '--find-links',
];
const REGISTRY_ENV =
  /^(?:NPM_CONFIG_REGISTRY|NPM_CONFIG_USERCONFIG|BUN_CONFIG_REGISTRY|YARN_REGISTRY|YARN_NPM_REGISTRY_SERVER|UV_INDEX|UV_INDEX_URL|UV_DEFAULT_INDEX|UV_EXTRA_INDEX_URL|UV_FIND_LINKS|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_FIND_LINKS|PIP_TRUSTED_HOST|UV_INSECURE_HOST|GOPROXY|GOFLAGS|GOSUMDB|GONOSUMDB|GONOSUMCHECK|GOINSECURE|GOPRIVATE|GONOPROXY|HTTPS?_PROXY|ALL_PROXY|NPM_CONFIG_(?:PROXY|HTTPS_PROXY|STRICT_SSL|CAFILE|CA)|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|PIP_CERT|SSL_CERT_(?:FILE|DIR)|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/u;
/** Python tools, where `-i` is the index (elsewhere, `docker run -i`, it means interactive). */
const PYTHON_TOOLS = new Set(['uv', 'uvx', 'pip', 'pip3', 'pipx']);

/** How deep a shell string inside a shell string is read. Past it, the line is still shown in full. */
const MAX_WRAPPER_DEPTH = 3;

const npmLike = (launcher: string, args: readonly string[], depth: number): UnpinnedPackage[] => {
  const calls = flagValues(args, ['-c', '--call']).flatMap(line => inLine(line, depth));
  const packages = flagValues(args, ['-p', '--package']);
  const specs = packages.length > 0 ? packages : operands(args, NPX_VALUED).slice(0, 1);
  return [...specs.filter(spec => !npmPinned(spec)).map(spec => ({ launcher, target: splitAt(spec).name })), ...calls];
};

const pythonLike = (launcher: string, args: readonly string[], main: boolean): UnpinnedPackage[] => {
  const from = flagValues(args, ['--from', '--spec']);
  const mainSpecs = main ? (from.length > 0 ? from : operands(args, UV_VALUED).slice(0, 1)) : [];
  return [...mainSpecs, ...flagValues(args, ['--with', '-w'])]
    .filter(spec => !pythonPinned(spec))
    .map(spec => ({ launcher, target: pythonName(spec) }));
};

/** The subcommand after any leading flags, and what follows it. */
const subcommand = (args: readonly string[]): { readonly name: string; readonly rest: readonly string[] } => {
  const index = args.findIndex(arg => !arg.startsWith('-'));
  return index === -1 ? { name: '', rest: [] } : { name: args[index] ?? '', rest: args.slice(index + 1) };
};

/** A container image is fixed only by its digest: a missing tag or `latest` moves, and any tag can be re-pushed. */
const containerRun = (program: string, all: readonly string[]): UnpinnedPackage[] => {
  const args = operands(all, DOCKER_GLOBAL_VALUED);
  const run = args[0] === 'run' ? args.slice(1) : args[0] === 'container' && args[1] === 'run' ? args.slice(2) : null;
  if (run === null) return [];
  const image = operands(run, DOCKER_VALUED)[0];
  return image === undefined || image.includes('@sha256:') ? [] : [{ launcher: `${program} run`, target: image }];
};

/** Every package a shell string fetches, one wrapper deeper. */
const inLine = (line: string, depth: number): UnpinnedPackage[] =>
  shellCommands(line).flatMap(([inner = '', ...innerArgs]) => launched(inner, innerArgs, depth + 1));

/** Every package this command line fetches at launch without a fixed version. */
function launched(command: string, args: readonly string[], depth: number): UnpinnedPackage[] {
  if (depth > MAX_WRAPPER_DEPTH) return [];
  const program = programName(command);
  const { name, rest } = subcommand(args);
  const line = shellLine(program, args);
  if (line !== undefined) return inLine(line, depth);
  switch (program) {
    case 'env': {
      // `env [-i] [-u NAME] [-C dir] NAME=value … program args`, or `env -S "program args"`.
      const split = flagValues(args, ['-S', '--split-string']);
      if (split.length > 0) return split.flatMap(text => inLine(text, depth));
      const after = operands(args, ENV_VALUED);
      const at = after.findIndex(arg => !arg.includes('='));
      return at === -1 ? [] : launched(after[at] ?? '', after.slice(at + 1), depth + 1);
    }
    case 'npx':
    case 'bunx':
    case 'pnpx':
      return npmLike(program, args, depth);
    case 'npm':
      return name === 'exec' || name === 'x' ? npmLike(`npm ${name}`, rest, depth) : [];
    case 'pnpm':
    case 'yarn':
      return name === 'dlx' ? npmLike(`${program} dlx`, rest, depth) : [];
    case 'bun':
      return name === 'x' ? npmLike('bun x', rest, depth) : [];
    case 'uvx':
      return pythonLike('uvx', args, true);
    case 'uv':
      if (name === 'tool' && rest[0] === 'run') return pythonLike('uv tool run', rest.slice(1), true);
      return name === 'run' ? pythonLike('uv run', rest, false) : [];
    case 'pipx':
      return name === 'run' ? pythonLike('pipx run', rest, true) : [];
    case 'docker':
    case 'podman':
      return containerRun(program, args);
    case 'go': {
      const spec = name === 'run' ? operands(rest, new Set())[0] : undefined;
      if (spec === undefined || !spec.includes('@')) return [];
      const { name: module, version } = splitAt(spec);
      return version !== undefined && EXACT_SEMVER.test(version) ? [] : [{ launcher: 'go run', target: module }];
    }
    case 'deno': {
      const spec = name === 'run' ? operands(rest, DENO_VALUED)[0] : undefined;
      if (spec === undefined) return [];
      if (/^https?:/u.test(spec)) return [{ launcher: 'deno run', target: spec }];
      const registry = /^(?:npm|jsr):(.+)$/u.exec(spec)?.[1];
      return registry === undefined || npmPinned(registry)
        ? []
        : [{ launcher: 'deno run', target: splitAt(registry).name }];
    }
    case 'nix': {
      const ref = name === 'run' || name === 'shell' ? operands(rest, new Set())[0] : undefined;
      return ref === undefined || LOCAL_PATH.test(ref) || /(?:rev=|\/)[0-9a-f]{40}/u.test(ref)
        ? []
        : [{ launcher: `nix ${name}`, target: ref }];
    }
    default:
      return [];
  }
}

/**
 * Every package this command line downloads at launch without naming a fixed version (gap G6, owner
 * decision Q15: warned, not refused). Recognises npx, bunx, `npm exec`, `pnpm dlx`/`pnpx`, `yarn dlx`,
 * `bun x`, uvx, `uv tool run`, `uv run --with`, `pipx run`, `docker`/`podman run`, `go run`, `deno run`
 * and `nix run`/`nix shell`, inside `sh -c`, `cmd /c`, `env` and `npx -c` too. Anything else is a program
 * already on the machine, which the review shows by its command line.
 *
 * Even an exact version is only the top of the tree: its own dependencies resolve fresh at each install.
 */
export function unpinnedPackages(command: string, args: readonly string[]): readonly UnpinnedPackage[] {
  return launched(command, args, 0);
}

/**
 * Where this command line fetches packages from, when it is not the public registry: a `--registry`,
 * `--index-url` or `--userconfig` flag anywhere (`-i` for Python tools), or a variable that sets a
 * registry, a proxy or which certificates are trusted. An exact version means nothing there — that
 * registry serves whatever bytes it likes for it.
 */
export function packageRegistries(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): readonly string[] {
  const lines = [[command, ...args], ...args.flatMap(arg => shellCommands(arg))];
  return [
    ...lines.flatMap(([program = '', ...rest]) =>
      flagValues(rest, PYTHON_TOOLS.has(programName(program)) ? [...REGISTRY_FLAGS, '-i'] : REGISTRY_FLAGS),
    ),
    ...Object.keys(env)
      .toSorted()
      .filter(name => REGISTRY_ENV.test(name))
      .map(name => `${name}=${env[name] ?? ''}`),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

// ── Warnings ─────────────────────────────────────────────────────────────────────────────────────

/** A file a ferret could run rather than read: a script by extension, or anything with a `#!` line. */
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|lua)$/iu;
const isScript = (file: { readonly path: string; readonly content: string }): boolean =>
  SCRIPT_EXTENSION.test(file.path) || file.content.startsWith('#!');

/** Files a tool runs or obeys on its own when it opens the folder: a direnv file, editor tasks, package scripts. */
const RUNS_ON_ITS_OWN =
  /(?:^|\/)(?:\.envrc|\.env|package\.json|Makefile|justfile|\.?mise\.toml|\.pre-commit-config\.yaml|\.mcp\.json|\.(?:vscode|idea|husky|claude|codex|agents|mise)\/.*)$/iu;

/** Which carried files hold what the raw-key rule would refuse in an MCP setup. A guess, so a warning. */
const filesWithPossibleSecret = (files: readonly { readonly path: string; readonly content: string }[]): string[] =>
  files.filter(file => holdsRawKey(file.content)).map(file => file.path);

const listed = (paths: readonly string[]): string => paths.join(', ');

/** Which carried files hold an invisible or text-direction character, which the review shows marked. */
const filesWithHidden = (files: readonly { readonly path: string; readonly content: string }[]): string[] =>
  files.filter(file => hiddenCharacters().test(file.content)).map(file => file.path);

/**
 * What a person must read before installing this item, from the item alone. The installer adds the
 * warnings only it can know (`first-publisher`, `older-version`, `edited-locally`).
 */
export function catalogItemWarnings(item: SharedCatalogItem): readonly CatalogInstallWarning[] {
  if (item.kind === 'skill') {
    const files = item.skill.files;
    const scripts = files.filter(isScript).map(file => file.path);
    const automatic = files.filter(file => RUNS_ON_ITS_OWN.test(file.path)).map(file => file.path);
    const hidden = filesWithHidden(files);
    const secrets = filesWithPossibleSecret(files);
    return [
      ...(scripts.length === 0
        ? []
        : [
            {
              code: 'carries-scripts' as const,
              text: `This skill carries ${scripts.length === 1 ? 'a script' : `${scripts.length} scripts`} a ferret may run: ${listed(scripts)}. Read ${scripts.length === 1 ? 'it' : 'them'} before installing.`,
            },
          ]),
      ...(automatic.length === 0
        ? []
        : [
            {
              code: 'runs-on-its-own' as const,
              text: `Some tools run or obey these files on their own when they open the folder: ${listed(automatic)}. Read them before installing.`,
            },
          ]),
      ...(hidden.length === 0
        ? []
        : [
            {
              code: 'hidden-characters' as const,
              text: `${listed(hidden)} ${hidden.length === 1 ? 'holds' : 'hold'} invisible or text-direction characters, shown below as ⟨U+…⟩. They can make text read differently from what it says.`,
            },
          ]),
      ...(secrets.length === 0
        ? []
        : [
            {
              code: 'possible-secret' as const,
              text: `${listed(secrets)} ${secrets.length === 1 ? 'holds' : 'hold'} what looks like a key or token. It may only be an example, but if it is real, installing this skill puts that credential on your computer, and it was seen by everyone who had the file.`,
            },
          ]),
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
  const unpinned = unpinnedPackages(setup.command, setup.args).map(
    (found): CatalogInstallWarning => ({
      code: 'unpinned-package',
      text: `${found.launcher} ${found.target} has no fixed version. It runs whatever is newest each time a ferret starts, so it can change without an update.`,
    }),
  );
  const registries = packageRegistries(setup.command, setup.args, setup.env).map(
    (registry): CatalogInstallWarning => ({
      code: 'package-registry',
      text: `It sets ${registry}, which changes where packages come from or which servers are trusted to send them. Whoever controls that can serve different files for the same version, so this item can change without an update.`,
    }),
  );
  return [...unpinned, ...registries];
}
