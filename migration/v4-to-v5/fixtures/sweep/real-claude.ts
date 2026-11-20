/**
 * `slot.ts real-claude <n> on <login> | off`: ONE real Claude on a persisted slot's 5.0 side, through one owner sign-in.
 *
 * 5.0 finds `claude` by the bare name on the daemon's PATH (the Logins sign-in) and by `harness-claude-code.yaml` (a ferret
 * launch); the slot puts its fake `harness-bin/claude` first on PATH. So the switch is that one file: `on` replaces it with a
 * small dispatcher that runs the REAL claude only when the login store it was handed (CLAUDE_SECURESTORAGE_CONFIG_DIR) is
 * exactly the chosen login's store, and runs the fake (`claude.fake`) for everybody else. `off` puts the fake back.
 *
 * Nothing here ever opens a file INSIDE the login's store (no credential, token or code is read or printed): `on` only checks
 * that the store is a real folder and makes it mode 0700. The pure parts (the shim text, the record, the login file check) are
 * unit-tested; `enableReal` / `disableReal` take their folders and ports as arguments so a test drives them on a scratch dir
 * with a stub "real" binary. Pure TypeScript with node: imports only, because a persisted slot runs this from its own kit copy.
 */
import {
  chmod,
  copyFile,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { shellQuote, storeRootOf } from './persist.ts';

/** The record `on` writes beside the 5.0 programs (inside `<slot>/v5/`): names and paths only, never a credential. */
export const RECORD_FILE = 'real-claude.json';
/** What the fake `claude` is renamed to while the shim stands in for it. */
export const FAKE_NAME = 'claude.fake';
/** The second line of every shim this kit writes: how `on` / `off` tell a shim from a fake. */
export const SHIM_MARKER = '# fy-sweep real-claude shim';

/**
 * What differs between the two real tools. Everything else (the record, the login checks, `on` / `off`) is one code path:
 * `claude` is the default of every function below, so its behaviour and its text are exactly what they were before `codex` existed.
 *
 * - claude: the harness is handed its login store as `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
 * - codex: a sign-in is run with `CODEX_HOME` = the login's store folder; a ferret is run with `CODEX_HOME` = its OWN home under
 *   `state/codex/agent-homes/<ferret>`, whose `auth.json` is a LINK to `<store>/auth.json` (the runtime wrapper makes it). So the
 *   codex shim matches the store exactly, or else that link's target (`readlink`, a path: the file is never opened).
 */
export interface RealTool {
  readonly name: 'claude' | 'codex';
  readonly recordFile: string;
  readonly fakeName: string;
  readonly marker: string;
  /** What a login file's `harness:` says for this tool. */
  readonly harnessValue: string;
}

export const CLAUDE_TOOL: RealTool = {
  name: 'claude',
  recordFile: RECORD_FILE,
  fakeName: FAKE_NAME,
  marker: SHIM_MARKER,
  harnessValue: 'claude-code',
};

export const CODEX_TOOL: RealTool = {
  name: 'codex',
  recordFile: 'real-codex.json',
  fakeName: 'codex.fake',
  marker: '# fy-sweep real-codex shim',
  harnessValue: 'codex',
};

/** The file Codex keeps its sign-in in, inside its home. Named here as a PATH to compare; never opened. */
const CODEX_AUTH_FILE = 'auth.json';

export interface RealClaudeRecord {
  readonly login: string;
  /** The exact string the shim compares CLAUDE_SECURESTORAGE_CONFIG_DIR with (the logical store path, as the daemon's environment spells it). */
  readonly store: string;
  /** The real claude: an absolute path, resolved once at `on`. */
  readonly binary: string;
  /** The GC root link that keeps `binary`'s store path alive, or null when it is not a nix store path / could not be rooted. */
  readonly rootedAt: string | null;
  /** True for `on --all`: `login` is ALL_LOGINS and `store` is the credentials ROOT, whose every direct child login dir gets the real binary. */
  readonly all?: boolean;
}

/** The `login` of an `--all` record. No login can be called this (loginNameProblem refuses it), so it never names a real login. */
export const ALL_LOGINS = '*';

/** Where 5.0 keeps ALL of a home's ferretry-managed login stores: the folder whose direct children are `<login id>`. */
export const credentialsRootOf = (fyHome: string): string => join(fyHome, 'state', 'logins', 'credentials');

/** A login id as 5.0 spells it in a file name: no slash, no dot-dot, no leading dash. */
export function loginNameProblem(login: string | undefined, tool: RealTool = CLAUDE_TOOL): string | undefined {
  if (login === undefined || login === '') return `name the login: slot.ts real-${tool.name} <n> on <login>`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(login) || login.includes('..'))
    return `"${login}" is not a login name (letters, digits, dot, dash and underscore only; no slash)`;
  return undefined;
}

/** Where 5.0 keeps a ferretry-managed login's store: the exact path the shim matches. */
export const storePathOf = (fyHome: string, login: string): string =>
  join(fyHome, 'state', 'logins', 'credentials', login);

/** Where the login's own file is: names and settings only. */
export const loginFileOf = (fyHome: string, login: string): string => join(fyHome, 'config', 'logins', `${login}.yaml`);

/**
 * The shim. Exact string match (a `case` pattern in quotes is literal, so no glob or link following) on the store; `--version`
 * and `-v` always go to the real binary (5.0 picks launch settings by the probed version); the real binary gets
 * DISABLE_AUTOUPDATER=1; everything else execs the fake.
 */
export interface ShimSpec {
  readonly fake: string;
  readonly real: string;
  /** One login's store, or (with `all`) the credentials root. */
  readonly store: string;
  /** The same by its realpath spelling, when that differs. */
  readonly realStore?: string;
  /** `--all` mode: `store` / `realStore` are the credentials root and the shim matches any one direct child dir of it. */
  readonly all?: boolean;
}

/**
 * The POSIX sh function the `--all` shims share. `fy_login_dir <path> <root>` succeeds only when <path> is exactly `<root>/<id>`:
 * a fixed prefix (both quoted, so a glob character in either is literal; nothing is evaluated), then <id> is ONE non-empty segment
 * that is not '.' or '..' and has no '/' (so a trailing slash, a nested child, a dot-dot and the root itself all fail), and <path>
 * is not itself a link (a link that leads out of the root gets the fake). No readlink -f, no eval, nothing is opened.
 */
const LOGIN_DIR_FUNCTION = [
  'fy_login_dir() {',
  '  case "$1" in "$2"/*) ;; *) return 1 ;; esac',
  '  fy_id=${1#"$2"/}',
  '  case "$fy_id" in \'\'|.|..|*/*) return 1 ;; esac',
  '  if [ -L "$1" ]; then return 1; fi',
  '  return 0',
  '}',
];

/** `fy_login_dir "$value" 'root' || fy_login_dir "$value" 'real root'` (one call when both spellings are the same). */
function underRoots(value: string, spec: ShimSpec): string {
  const roots = [...new Set([spec.store, spec.realStore ?? spec.store])];
  return roots.map(root => `fy_login_dir "${value}" ${shellQuote(root)}`).join(' || ');
}

export function shimText(spec: ShimSpec, tool: RealTool = CLAUDE_TOOL): string {
  for (const path of [spec.fake, spec.real, spec.store, ...(spec.realStore === undefined ? [] : [spec.realStore])])
    if (!isAbsolute(path) || /[\n\r\0]/u.test(path))
      throw new Error(`shim paths must be absolute single-line paths: ${path}`);
  const real = shellQuote(spec.real);
  if (tool.name === 'codex') return codexShimText(spec, real, tool);
  if (spec.all === true)
    return [
      '#!/bin/sh',
      SHIM_MARKER,
      '# Real claude ONLY for a login store that is a direct child of the credentials root below; every other caller gets the fake. Written by `slot.ts real-claude --all`.',
      'case "${1-}" in',
      `  --version|-v) exec env DISABLE_AUTOUPDATER=1 ${real} "$@" ;;`,
      'esac',
      ...LOGIN_DIR_FUNCTION,
      'fy_dir=${CLAUDE_SECURESTORAGE_CONFIG_DIR-}',
      `if ${underRoots('$fy_dir', spec)}; then exec env DISABLE_AUTOUPDATER=1 ${real} "$@"; fi`,
      `exec ${shellQuote(spec.fake)} "$@"`,
      '',
    ].join('\n');
  return [
    '#!/bin/sh',
    SHIM_MARKER,
    '# Real claude ONLY for the one login store below; every other caller gets the fake. Written by `slot.ts real-claude`.',
    'case "${1-}" in',
    `  --version|-v) exec env DISABLE_AUTOUPDATER=1 ${real} "$@" ;;`,
    'esac',
    'case "${CLAUDE_SECURESTORAGE_CONFIG_DIR-}" in',
    `  ${shellQuote(spec.store)}) exec env DISABLE_AUTOUPDATER=1 ${real} "$@" ;;`,
    'esac',
    `exec ${shellQuote(spec.fake)} "$@"`,
    '',
  ].join('\n');
}

/**
 * The codex shim: the real codex for (1) `--version` / `-V`, (2) a CODEX_HOME that is exactly the login's store (the sign-in, and
 * the daemon's own token refresh), (3) a CODEX_HOME whose `auth.json` is a link whose target is exactly `<store>/auth.json` (logical or real path) (a ferret
 * on a runtime of that login). Every other caller gets the fake. `readlink` prints the link's target path only; no file is opened.
 */
function codexShimText(spec: ShimSpec, real: string, tool: RealTool): string {
  if (spec.all === true)
    return [
      '#!/bin/sh',
      tool.marker,
      '# Real codex ONLY for a login store that is a direct child of the credentials root below; every other caller gets the fake. Written by `slot.ts real-codex --all`.',
      'case "${1-}" in',
      `  --version|-V) d=$(mktemp -d 2>/dev/null) || d=/nonexistent-fy-sweep-codex-home; CODEX_HOME="$d" ${real} "$@"; rc=$?; rm -rf "$d"; exit "$rc" ;;`,
      'esac',
      ...LOGIN_DIR_FUNCTION,
      'fy_home=${CODEX_HOME-}',
      `if ${underRoots('$fy_home', spec)}; then exec ${real} "$@"; fi`,
      // A ferret: its home's auth.json is a link to <root>/<id>/auth.json. The link target is only read as a path, never opened.
      'if [ -n "$fy_home" ] && [ -L "$fy_home/auth.json" ]; then',
      '  fy_link=$(readlink "$fy_home/auth.json" 2>/dev/null)',
      '  case "$fy_link" in',
      '    */auth.json)',
      '      fy_dir=${fy_link%/auth.json}',
      `      if ${underRoots('$fy_dir', spec)}; then exec ${real} "$@"; fi ;;`,
      '  esac',
      'fi',
      `exec ${shellQuote(spec.fake)} "$@"`,
      '',
    ].join('\n');
  const store = shellQuote(spec.store);
  // The link's target is the LOGICAL store's auth.json or the same file by its REAL path: a persisted slot's FY_HOME goes through a
  // link, and the 5.0 kernel writes the ferret's link with the real path. Exactly these two strings; never a prefix, glob or readlink -f.
  const targets = [...new Set([spec.store, spec.realStore ?? spec.store])].map(s =>
    shellQuote(join(s, CODEX_AUTH_FILE)),
  );
  return [
    '#!/bin/sh',
    tool.marker,
    '# Real codex ONLY for the one login store below; every other caller gets the fake. Written by `slot.ts real-codex`.',
    'case "${1-}" in',
    // codex's startup touches its home (a .env load, a tmp dir) before it prints, so --version gets a THROWAWAY home, removed after.
    `  --version|-V) d=$(mktemp -d 2>/dev/null) || d=/nonexistent-fy-sweep-codex-home; CODEX_HOME="$d" ${real} "$@"; rc=$?; rm -rf "$d"; exit "$rc" ;;`,
    'esac',
    'case "${CODEX_HOME-}" in',
    `  ${store}) exec ${real} "$@" ;;`,
    'esac',
    'if [ -n "${CODEX_HOME-}" ] && [ -L "$CODEX_HOME/auth.json" ]; then',
    '  case "$(readlink "$CODEX_HOME/auth.json" 2>/dev/null)" in',
    `    ${targets.join('|')}) exec ${real} "$@" ;;`,
    '  esac',
    'fi',
    `exec ${shellQuote(spec.fake)} "$@"`,
    '',
  ].join('\n');
}

export const isShim = (text: string, tool: RealTool = CLAUDE_TOOL): boolean => text.split('\n')[1] === tool.marker;

export function recordText(record: RealClaudeRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The record from its text, or undefined when it is not a record this kit wrote. */
export function parseRecord(text: string): RealClaudeRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.login !== 'string' || typeof r.store !== 'string' || typeof r.binary !== 'string') return undefined;
  if (r.rootedAt !== null && typeof r.rootedAt !== 'string') return undefined;
  return {
    login: r.login,
    store: r.store,
    binary: r.binary,
    rootedAt: r.rootedAt,
    ...(r.all === true && r.login === ALL_LOGINS ? { all: true } : {}),
  };
}

/** One top-level `key: value` of a login YAML, quotes and a trailing comment removed; undefined when absent. */
export function topLevelValue(yaml: string, key: string): string | undefined {
  for (const line of yaml.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] !== key) continue;
    const raw = (match[2] ?? '').replace(/\s+#.*$/u, '');
    const quoted = /^(["'])(.*)\1$/u.exec(raw);
    return quoted?.[2] ?? raw;
  }
  return undefined;
}

/** Why a login file is not one this verb may switch on, or undefined when it is `harness: claude-code` + `store: ferretry`. */
export function loginFileProblem(login: string, yaml: string, tool: RealTool = CLAUDE_TOOL): string | undefined {
  const harness = topLevelValue(yaml, 'harness');
  const store = topLevelValue(yaml, 'store');
  if (harness !== tool.harnessValue)
    return `login ${login} is "harness: ${harness ?? '(none)'}", not ${tool.harnessValue}`;
  if (store !== 'ferretry')
    return `login ${login} is "store: ${store ?? '(none)'}", not ferretry (a host login uses your own terminal's sign-in and is never touched here)`;
  return undefined;
}

/** The runtime names (file names under config/runtimes/) whose file says `login: <login>`. Names only. */
export function runtimesUsing(login: string, files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([, yaml]) => topLevelValue(yaml, 'login') === login)
    .map(([name]) => name.replace(/\.ya?ml$/u, ''))
    .sort();
}

/** The `real claude:` line `status` and `upgrade-v5` print. */
export function statusLine(
  record: RealClaudeRecord | undefined,
  state: 'ok' | 'shim-missing' = 'ok',
  tool: RealTool = CLAUDE_TOOL,
): string {
  if (record === undefined) return `real ${tool.name}: off (every ${tool.name} is the fake)`;
  const base =
    record.all === true
      ? `real ${tool.name}: on for every login (${record.binary})`
      : `real ${tool.name}: on for login ${record.login} (${record.binary})`;
  return state === 'ok'
    ? base
    : `${base}  WARNING: harness-bin/${tool.name} is not the shim any more; run real-${tool.name} on again`;
}

// ─── on / off, with their folders and ports as arguments ─────────────────────────────────────────────────────────────

export interface RealPaths {
  /** `<slot>/v5`: the record lives here. */
  readonly v5Dir: string;
  /** The 5.0 FY_HOME the daemon runs with (its logical path: what the daemon's own environment says). */
  readonly fyHome: string;
  /** `<slot>/v5/harness-bin`. */
  readonly harness: string;
}

export const recordPathOf = (paths: RealPaths, tool: RealTool = CLAUDE_TOOL): string =>
  join(paths.v5Dir, tool.recordFile);

export async function readRecord(
  paths: RealPaths,
  tool: RealTool = CLAUDE_TOOL,
): Promise<RealClaudeRecord | undefined> {
  const text = await readFile(recordPathOf(paths, tool), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseRecord(text);
}

/** A refusal: a sentence to say and nothing changed. */
export class Refusal extends Error {}

const refuse = (sentence: string): never => {
  throw new Refusal(sentence);
};

export interface EnablePorts {
  /**
   * Runs `<binary> --version` (with a throwaway CODEX_HOME for codex) and returns its first line, or undefined when it could not
   * run. Optional: when given, `on` for codex refuses a binary whose version line does not name codex, and prints the line.
   */
  readonly version?: (binary: string) => Promise<string | undefined>;
  /** Roots the binary's store path; returns the root link or undefined (with a reason said by the caller). */
  readonly root: (binary: string) => Promise<{ readonly link: string | undefined; readonly note?: string }>;
}

/** Writes `path` atomically (a temp file in the same folder, then a rename), mode 0755. */
async function writeExecutable(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${String(process.pid)}`;
  await writeFile(temp, text, { mode: 0o755 });
  await chmod(temp, 0o755);
  await rename(temp, path);
}

/** How much of a binary is read to spot a shim: the marker sits on the shim's second line. */
const HEAD_BYTES = 400;

/** The first `count` bytes of a file as text; '' when it cannot be read. Never the whole file. */
async function headOf(path: string, count: number): Promise<string> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) return '';
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function enableReal(
  paths: RealPaths,
  login: string | undefined,
  binary: string,
  ports: EnablePorts,
  tool: RealTool = CLAUDE_TOOL,
): Promise<{ readonly record: RealClaudeRecord; readonly notes: string[] }> {
  const all = login === ALL_LOGINS;
  const bad = all ? undefined : loginNameProblem(login, tool);
  if (bad !== undefined || login === undefined) return refuse(bad ?? 'name the login');
  const notes: string[] = [];
  const existing = await readRecord(paths, tool);
  if (existing !== undefined && (existing.all === true) !== all)
    refuse(
      `real ${tool.name} is already on ${existing.all === true ? 'for every login' : `for login ${existing.login}`}; run "real-${tool.name} <n> off" first (it never deletes a login), then switch on the other way`,
    );
  if (existing !== undefined && existing.login !== login)
    refuse(
      `real ${tool.name} is already on for login ${existing.login}; one real login at a time. Run "real-${tool.name} <n> off" first (it never deletes that login)`,
    );

  // The login: its file exists and is claude-code + ferretry; its store, when it exists, is a real folder (a link is refused, nothing
  // inside it is read). 5.0 creates the store only at sign-in (mode 0700), so a login that was added but not signed in has none yet.
  // `--all`: no single login to check; the credentials ROOT is what the shim matches under, and it must not be a link.
  const yaml = all ? '' : await readFile(loginFileOf(paths.fyHome, login), 'utf8').catch(() => undefined);
  if (yaml === undefined)
    return refuse(
      `login ${login} does not exist (${loginFileOf(paths.fyHome, login)} is missing). Add it first on the 5.0 Logins screen: Add login, ${tool.name === 'codex' ? 'Codex' : 'Claude Code'}, Ferretry-managed`,
    );
  const problem = all ? undefined : loginFileProblem(login, yaml, tool);
  if (problem !== undefined) return refuse(problem);
  const store = all ? credentialsRootOf(paths.fyHome) : storePathOf(paths.fyHome, login);
  const found = await lstat(store).catch(() => undefined);
  if (found?.isSymbolicLink() === true)
    return refuse(`${store} is a symbolic link; refusing to point the real ${tool.name} at it`);
  if (found !== undefined && !found.isDirectory()) return refuse(`${store} is not a folder`);

  // The real binary: an absolute, executable file that is neither a shim nor inside the slot's harness folder.
  if (!isAbsolute(binary) || resolve(binary) !== binary)
    return refuse(`the real ${tool.name} must be an absolute path, not "${binary}"`);
  const real = await realpath(binary).catch(() => undefined);
  if (real === undefined) return refuse(`the real ${tool.name} ${binary} does not exist`);
  const info = await stat(real);
  if (!info.isFile() || (info.mode & 0o111) === 0) return refuse(`${real} is not an executable file`);
  // Compare with the harness folder's REAL path: `real` is realpath'd, and a persisted slot's logical path may go through a link.
  const harnessReal = await realpath(paths.harness).catch(() => resolve(paths.harness));
  const inside = relative(harnessReal, real);
  if (!inside.startsWith('..') && !isAbsolute(inside))
    return refuse(`${real} is inside the slot's harness-bin: that is the fake, not a real ${tool.name}`);
  if ((await headOf(real, HEAD_BYTES)).includes(tool.marker))
    return refuse(`${real} is a real-${tool.name} shim, not a real ${tool.name}`);

  // Codex only: print what the binary says it is, and refuse a binary that does not say codex (a wrapper, another tool).
  if (tool.name === 'codex' && ports.version !== undefined) {
    const said = await ports.version(real);
    if (said === undefined)
      return refuse(`${real} --version did not run; refusing a binary that cannot say what it is`);
    if (!/codex/iu.test(said)) return refuse(`${real} --version says "${said}", which does not name codex; refusing`);
    notes.push(`${real} --version: ${said}`);
  }

  // An existing folder is made private to its owner (a mode change only; its content is not opened). A missing one is left for
  // 5.0 to create at sign-in, already 0700.
  if (found !== undefined) await chmod(store, 0o700);
  if (all && found !== undefined)
    for (const name of await readdir(store).catch(() => [] as string[])) {
      const child = join(store, name);
      if ((await lstat(child).catch(() => undefined))?.isDirectory() === true) await chmod(child, 0o700);
    }

  // The shim goes in. The fake is kept as claude.fake and never overwritten by a shim.
  const claude = join(paths.harness, tool.name);
  const fake = join(paths.harness, tool.fakeName);
  const current = await readFile(claude, 'utf8').then(
    text => text,
    () => undefined,
  );
  if (current === undefined && (await lstat(fake).catch(() => undefined)) === undefined)
    return refuse(
      `${claude} is missing: this slot has no fake ${tool.name} to keep (run it through sweep-up.sh first)`,
    );
  const fakeThere = (await lstat(fake).catch(() => undefined)) !== undefined;
  if (current !== undefined && !isShim(current, tool)) {
    if (fakeThere)
      return refuse(
        `both ${claude} and ${fake} are fakes; refusing to overwrite one. Look at them and remove the stale one`,
      );
    await copyFile(claude, fake);
    await chmod(fake, 0o755);
  }
  // A persisted slot's FY_HOME goes through a link; the codex ferret's auth.json link is written with the REAL path, so the shim also
  // accepts the store spelled by realpath(fyHome). A fyHome that cannot be resolved leaves only the logical spelling.
  const realFyHome = await realpath(paths.fyHome).catch(() => undefined);
  const realStore =
    realFyHome === undefined ? undefined : all ? credentialsRootOf(realFyHome) : storePathOf(realFyHome, login);
  const linked = await ports.root(real);
  if (linked.note !== undefined) notes.push(linked.note);
  await writeExecutable(
    claude,
    shimText({ fake, real, store, ...(realStore === undefined ? {} : { realStore }), ...(all ? { all } : {}) }, tool),
  );
  const record: RealClaudeRecord = {
    login,
    store,
    binary: real,
    rootedAt: linked.link ?? null,
    ...(all ? { all } : {}),
  };
  const temp = `${recordPathOf(paths, tool)}.tmp-${String(process.pid)}`;
  await writeFile(temp, recordText(record), { mode: 0o644 });
  await rename(temp, recordPathOf(paths, tool));
  return { record, notes };
}

export interface DisablePorts {
  /** A sentence when a live ferret still runs on a runtime that uses the login (names only), else undefined. */
  readonly liveFerrets: (login: string) => Promise<string | undefined>;
}

export async function disableReal(
  paths: RealPaths,
  ports: DisablePorts,
  options: { readonly force: boolean },
  tool: RealTool = CLAUDE_TOOL,
): Promise<{ readonly was: RealClaudeRecord | undefined }> {
  const record = await readRecord(paths, tool);
  if (record === undefined) {
    const claude = await readFile(join(paths.harness, tool.name), 'utf8').catch(() => '');
    if (isShim(claude, tool))
      return refuse(
        `harness-bin/${tool.name} is a shim but there is no ${tool.recordFile}; refusing to guess. Restore it by hand: mv ${join(paths.harness, tool.fakeName)} ${join(paths.harness, tool.name)}`,
      );
    return { was: undefined };
  }
  if (!options.force) {
    const live = await ports.liveFerrets(record.login);
    if (live !== undefined) return refuse(live);
  }
  const fake = join(paths.harness, tool.fakeName);
  if ((await lstat(fake).catch(() => undefined)) === undefined)
    return refuse(`${fake} is missing, so the fake ${tool.name} cannot be put back; nothing was changed`);
  // Atomic: the fake takes the shim's place in one rename. The login and its store are not touched.
  await rename(fake, join(paths.harness, tool.name));
  await rm(recordPathOf(paths, tool), { force: true });
  if (record.rootedAt !== null) {
    const link = await lstat(record.rootedAt).catch(() => undefined);
    if (
      link?.isSymbolicLink() === true &&
      basename(record.rootedAt) === (storeRootOf(record.binary)?.slice('/nix/store/'.length) ?? '\0')
    )
      await rm(record.rootedAt, { force: true });
  }
  return { was: record };
}
