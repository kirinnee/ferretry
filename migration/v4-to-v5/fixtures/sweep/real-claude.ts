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
import { chmod, copyFile, lstat, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { shellQuote, storeRootOf } from './persist.ts';

/** The record `on` writes beside the 5.0 programs (inside `<slot>/v5/`): names and paths only, never a credential. */
export const RECORD_FILE = 'real-claude.json';
/** What the fake `claude` is renamed to while the shim stands in for it. */
export const FAKE_NAME = 'claude.fake';
/** The second line of every shim this kit writes: how `on` / `off` tell a shim from a fake. */
export const SHIM_MARKER = '# fy-sweep real-claude shim';

export interface RealClaudeRecord {
  readonly login: string;
  /** The exact string the shim compares CLAUDE_SECURESTORAGE_CONFIG_DIR with. */
  readonly store: string;
  /** The real claude: an absolute path, resolved once at `on`. */
  readonly binary: string;
  /** The GC root link that keeps `binary`'s store path alive, or null when it is not a nix store path / could not be rooted. */
  readonly rootedAt: string | null;
}

/** A login id as 5.0 spells it in a file name: no slash, no dot-dot, no leading dash. */
export function loginNameProblem(login: string | undefined): string | undefined {
  if (login === undefined || login === '') return 'name the login: slot.ts real-claude <n> on <login>';
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
export function shimText(spec: { readonly fake: string; readonly real: string; readonly store: string }): string {
  for (const path of [spec.fake, spec.real, spec.store])
    if (!isAbsolute(path) || /[\n\r\0]/u.test(path))
      throw new Error(`shim paths must be absolute single-line paths: ${path}`);
  const real = shellQuote(spec.real);
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

export const isShim = (text: string): boolean => text.split('\n')[1] === SHIM_MARKER;

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
  return { login: r.login, store: r.store, binary: r.binary, rootedAt: r.rootedAt };
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
export function loginFileProblem(login: string, yaml: string): string | undefined {
  const harness = topLevelValue(yaml, 'harness');
  const store = topLevelValue(yaml, 'store');
  if (harness !== 'claude-code') return `login ${login} is "harness: ${harness ?? '(none)'}", not claude-code`;
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
export function statusLine(record: RealClaudeRecord | undefined, state: 'ok' | 'shim-missing' = 'ok'): string {
  if (record === undefined) return 'real claude: off (every claude is the fake)';
  const base = `real claude: on for login ${record.login} (${record.binary})`;
  return state === 'ok'
    ? base
    : `${base}  WARNING: harness-bin/claude is not the shim any more; run real-claude on again`;
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

export const recordPathOf = (paths: RealPaths): string => join(paths.v5Dir, RECORD_FILE);

export async function readRecord(paths: RealPaths): Promise<RealClaudeRecord | undefined> {
  const text = await readFile(recordPathOf(paths), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseRecord(text);
}

/** A refusal: a sentence to say and nothing changed. */
export class Refusal extends Error {}

const refuse = (sentence: string): never => {
  throw new Refusal(sentence);
};

export interface EnablePorts {
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
): Promise<{ readonly record: RealClaudeRecord; readonly notes: string[] }> {
  const bad = loginNameProblem(login);
  if (bad !== undefined || login === undefined) return refuse(bad ?? 'name the login');
  const notes: string[] = [];
  const existing = await readRecord(paths);
  if (existing !== undefined && existing.login !== login)
    refuse(
      `real claude is already on for login ${existing.login}; one real login at a time. Run "real-claude <n> off" first (it never deletes that login)`,
    );

  // The login: its file exists and is claude-code + ferretry; its store, when it exists, is a real folder (a link is refused, nothing
  // inside it is read). 5.0 creates the store only at sign-in (mode 0700), so a login that was added but not signed in has none yet.
  const yaml = await readFile(loginFileOf(paths.fyHome, login), 'utf8').catch(() => undefined);
  if (yaml === undefined)
    return refuse(
      `login ${login} does not exist (${loginFileOf(paths.fyHome, login)} is missing). Add it first on the 5.0 Logins screen: Add login, Claude Code, Ferretry-managed`,
    );
  const problem = loginFileProblem(login, yaml);
  if (problem !== undefined) return refuse(problem);
  const store = storePathOf(paths.fyHome, login);
  const found = await lstat(store).catch(() => undefined);
  if (found?.isSymbolicLink() === true)
    return refuse(`${store} is a symbolic link; refusing to point the real claude at it`);
  if (found !== undefined && !found.isDirectory()) return refuse(`${store} is not a folder`);

  // The real binary: an absolute, executable file that is neither a shim nor inside the slot's harness folder.
  if (!isAbsolute(binary) || resolve(binary) !== binary)
    return refuse(`the real claude must be an absolute path, not "${binary}"`);
  const real = await realpath(binary).catch(() => undefined);
  if (real === undefined) return refuse(`the real claude ${binary} does not exist`);
  const info = await stat(real);
  if (!info.isFile() || (info.mode & 0o111) === 0) return refuse(`${real} is not an executable file`);
  // Compare with the harness folder's REAL path: `real` is realpath'd, and a persisted slot's logical path may go through a link.
  const harnessReal = await realpath(paths.harness).catch(() => resolve(paths.harness));
  const inside = relative(harnessReal, real);
  if (!inside.startsWith('..') && !isAbsolute(inside))
    return refuse(`${real} is inside the slot's harness-bin: that is the fake, not a real claude`);
  if ((await headOf(real, HEAD_BYTES)).includes(SHIM_MARKER))
    return refuse(`${real} is a real-claude shim, not a real claude`);

  // An existing folder is made private to its owner (a mode change only; its content is not opened). A missing one is left for
  // 5.0 to create at sign-in, already 0700.
  if (found !== undefined) await chmod(store, 0o700);

  // The shim goes in. The fake is kept as claude.fake and never overwritten by a shim.
  const claude = join(paths.harness, 'claude');
  const fake = join(paths.harness, FAKE_NAME);
  const current = await readFile(claude, 'utf8').then(
    text => text,
    () => undefined,
  );
  if (current === undefined && (await lstat(fake).catch(() => undefined)) === undefined)
    return refuse(`${claude} is missing: this slot has no fake claude to keep (run it through sweep-up.sh first)`);
  const fakeThere = (await lstat(fake).catch(() => undefined)) !== undefined;
  if (current !== undefined && !isShim(current)) {
    if (fakeThere)
      return refuse(
        `both ${claude} and ${fake} are fakes; refusing to overwrite one. Look at them and remove the stale one`,
      );
    await copyFile(claude, fake);
    await chmod(fake, 0o755);
  }
  const linked = await ports.root(real);
  if (linked.note !== undefined) notes.push(linked.note);
  await writeExecutable(claude, shimText({ fake, real, store }));
  const record: RealClaudeRecord = { login, store, binary: real, rootedAt: linked.link ?? null };
  const temp = `${recordPathOf(paths)}.tmp-${String(process.pid)}`;
  await writeFile(temp, recordText(record), { mode: 0o644 });
  await rename(temp, recordPathOf(paths));
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
): Promise<{ readonly was: RealClaudeRecord | undefined }> {
  const record = await readRecord(paths);
  if (record === undefined) {
    const claude = await readFile(join(paths.harness, 'claude'), 'utf8').catch(() => '');
    if (isShim(claude))
      return refuse(
        `harness-bin/claude is a shim but there is no ${RECORD_FILE}; refusing to guess. Restore it by hand: mv ${join(paths.harness, FAKE_NAME)} ${join(paths.harness, 'claude')}`,
      );
    return { was: undefined };
  }
  if (!options.force) {
    const live = await ports.liveFerrets(record.login);
    if (live !== undefined) return refuse(live);
  }
  const fake = join(paths.harness, FAKE_NAME);
  if ((await lstat(fake).catch(() => undefined)) === undefined)
    return refuse(`${fake} is missing, so the fake claude cannot be put back; nothing was changed`);
  // Atomic: the fake takes the shim's place in one rename. The login and its store are not touched.
  await rename(fake, join(paths.harness, 'claude'));
  await rm(recordPathOf(paths), { force: true });
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
