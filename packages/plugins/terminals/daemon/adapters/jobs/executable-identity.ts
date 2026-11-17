/**
 * PROVING THE EXECUTABLE, NOT THE TEXT (docs/jobs.md, "What counts as an attachment").
 *
 * A process's command line is whatever it says it is: `exec -a "fy job attach x" sleep 600` and a `perl` that sets `$0` both
 * read as `fy job attach x`. The registry the move gate trusts therefore also proves WHICH FILE the process runs, and only
 * a process that runs the daemon-known `fy` executable is an attachment.
 *
 * An identity is an opaque string, equal exactly when two processes run the same file:
 *
 * - `dev:ino` of what `/proc/<pid>/exe` reaches (Linux; the kernel keeps it, a process cannot rewrite it), or of the first
 *   text-mapped file `lsof` reports (macOS; the path is resolved first);
 * - a JavaScript runtime (`bun fy.ts`, the dev shape) adds `#<real path of its script>`, so the runtime alone is never enough.
 *
 * Anything that cannot be read answers `'unknown'`, and every caller refuses on `'unknown'` (fail closed).
 */
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readlink, readText, realpath, stat } from '../host/fs.ts';

/** The JavaScript runtimes `fy` runs under in development; mirrors `std`'s `harness-process.ts`. */
const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);

/** What a macOS `lsof` run answered; kept to the two facts the reading needs. */
interface LsofRun {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export interface ExecutableReads {
  readonly platform: string;
  /** Runs `lsof` with these arguments (macOS only). */
  readonly lsof: (args: readonly string[]) => Promise<LsofRun>;
  readonly procRoot?: string;
}

/** `dev:ino` of what `path` reaches (links followed), or `undefined` when it cannot be read. */
export async function fileIdentity(path: string): Promise<string | undefined> {
  try {
    const found = await stat(path, { bigint: true });
    return found.isFile() ? `${found.dev}:${found.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** The script a runtime was handed: the first word after the runtime that is not an option (and not the `run` verb). */
export function scriptWord(words: readonly string[]): string | undefined {
  return words.slice(1).find(word => !word.startsWith('-') && word !== 'run');
}

/** The real path of a script named by a process, resolved against that process's own working folder. */
async function scriptIdentity(words: readonly string[], cwd: string | undefined): Promise<string | undefined> {
  const word = scriptWord(words);
  if (word === undefined) return undefined;
  const absolute = isAbsolute(word) ? word : cwd === undefined ? undefined : join(cwd, word);
  if (absolute === undefined) return undefined;
  try {
    return await realpath(absolute);
  } catch {
    return undefined;
  }
}

async function linuxIdentity(pid: number, procRoot: string): Promise<string> {
  const base = `${procRoot}/${pid}`;
  try {
    const identity = await fileIdentity(`${base}/exe`);
    if (identity === undefined) return 'unknown';
    const program = await readlink(`${base}/exe`);
    if (!RUNTIMES.has(basename(program.replace(/ \(deleted\)$/u, '')))) return identity;
    const words = (await readText(`${base}/cmdline`)).split('\0').filter(word => word !== '');
    const cwd = await readlink(`${base}/cwd`).catch(() => undefined);
    const script = await scriptIdentity(words, cwd);
    return script === undefined ? 'unknown' : `${identity}#${script}`;
  } catch {
    return 'unknown';
  }
}

async function darwinIdentity(pid: number, lsof: ExecutableReads['lsof']): Promise<string> {
  try {
    const ran = await lsof(['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
    if (ran.exitCode !== 0) return 'unknown';
    // `-Fn` prints `p<pid>` then one `n<name>` per mapped file; the first text mapping is the program itself.
    const first = ran.stdout.split('\n').find(line => line.startsWith('n') && isAbsolute(line.slice(1)));
    if (first === undefined) return 'unknown';
    const real = await realpath(first.slice(1)).catch(() => undefined);
    const identity = real === undefined ? undefined : await fileIdentity(real);
    // A runtime under macOS carries no script proof here, so it never matches an entry that needs one.
    return identity ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The identity of the file process `pid` runs: `'unknown'` when it cannot be read (always a refusal). */
export async function executableIdentityOf(pid: number, reads: ExecutableReads): Promise<string | 'unknown'> {
  if (reads.platform === 'linux') return await linuxIdentity(pid, reads.procRoot ?? '/proc');
  if (reads.platform === 'darwin') return await darwinIdentity(pid, reads.lsof);
  return 'unknown';
}

export interface TrustedSources {
  /** `process.execPath` of the daemon. */
  readonly execPath: string;
  /** Where `fy` resolves on the daemon's own search path (`kernel.paths.which`), when it does. */
  readonly which: (name: string) => Promise<string | undefined>;
  /** The CLI's own entry in a source checkout (`bin/fy.ts`), used only when the daemon itself runs under a runtime. */
  readonly sourceEntry?: string;
  readonly binaryName: string;
}

/**
 * The identities that ARE `fy`, as the daemon can tell on its own: the `fy` installed beside the daemon's executable and the
 * one on the daemon's search path. A daemon running under a JavaScript runtime (a source checkout) also trusts that runtime
 * running the checkout's own CLI entry, and only that.
 */
export async function trustedExecutables(sources: TrustedSources): Promise<readonly string[]> {
  const paths = [join(dirname(sources.execPath), sources.binaryName), await sources.which(sources.binaryName)];
  const found = new Set<string>();
  for (const path of paths) {
    if (path === undefined) continue;
    const identity = await fileIdentity(path);
    // A runtime file is never trusted bare: a `fy` link that points at `bun` would admit every bun process.
    if (identity !== undefined && !RUNTIMES.has(basename(await realpath(path).catch(() => path)))) found.add(identity);
  }
  if (RUNTIMES.has(basename(sources.execPath)) && sources.sourceEntry !== undefined) {
    const runtime = await fileIdentity(sources.execPath);
    const entry = await realpath(sources.sourceEntry).catch(() => undefined);
    if (runtime !== undefined && entry !== undefined) found.add(`${runtime}#${entry}`);
  }
  return [...found];
}
