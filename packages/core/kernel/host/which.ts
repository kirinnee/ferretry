/**
 * `kernel.paths.which`: a bare executable NAME resolved to a path under the kernel's control — today's lookups
 * (`Bun.which(name, { PATH })` for an MCP server's command, the harness rule's search directories then the inherited
 * `PATH`, `harness-readiness.ts`), with nothing a plugin could widen and nothing it could run:
 *
 * - The name is ONE plain command name (letters, digits, `.`, `_`, `+`, `-`; 128 at most; no `/`, so never a path,
 *   and never `.` or `..`). Anything else is not looked up: the answer is absent.
 * - The directories searched are the caller's own (`directories`: the harness search folders a config names) and
 *   then the daemon's inherited `PATH`, in that order, first match wins. Each must be ABSOLUTE and plain (no `.` or
 *   `..` segment, no NUL); an empty, relative or odd entry is dropped, never resolved against a working folder (a
 *   relative `PATH` entry found commands in whatever folder the daemon was started in). At most
 *   {@link MAX_SEARCH_DIRECTORIES} are searched, duplicates once.
 * - A candidate `<dir>/<name>` is the answer when the probe says it is a regular file (links followed, as a shell
 *   follows them) this process may execute. Nothing is ever executed, and no shell is involved.
 * - The answer is that path or `undefined`: never the `PATH` itself, never why a candidate was passed over.
 *
 * Pure but for the probe, which the host's adapter answers from the disk (`./adapters/executable.ts`) and the testing
 * host from its own world — the same function decides for both.
 */

/** The most folders one lookup searches, the caller's and `PATH`'s together. */
export const MAX_SEARCH_DIRECTORIES = 64;

/** One plain command name: never a path, never `.` or `..`. */
const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}$/u;

/** Whether an absolute path names a regular file (links followed) this process may execute. Never runs it. */
export type ExecutableProbe = (absolutePath: string) => Promise<boolean>;

/** Whether `name` is one this lookup will search for. */
const isCommandName = (name: unknown): name is string =>
  typeof name === 'string' && COMMAND_NAME.test(name) && name !== '.' && name !== '..';

/** A folder a lookup may search: absolute, plain, no NUL; a trailing `/` is dropped. */
function searchable(directory: unknown): string | undefined {
  if (typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('\0')) return undefined;
  const trimmed = directory.length > 1 ? directory.replace(/\/+$/u, '') : directory;
  const segments = trimmed.split('/').slice(1);
  if (trimmed !== '/' && segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    return undefined;
  return trimmed;
}

/** The folders a lookup searches, in order: the caller's, then `PATH`'s, each kept once, bounded. */
export function searchDirectories(path: string | undefined, directories: readonly unknown[] = []): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const extra = Array.isArray(directories) ? directories : [];
  for (const candidate of [...extra, ...(path ?? '').split(':')]) {
    if (found.length >= MAX_SEARCH_DIRECTORIES) break;
    const directory = searchable(candidate);
    if (directory === undefined || seen.has(directory)) continue;
    seen.add(directory);
    found.push(directory);
  }
  return found;
}

/** The first `<dir>/<name>` the probe accepts, or `undefined`. A probe that throws passes that candidate over. */
export async function whichCommand(
  name: unknown,
  search: { readonly path: string | undefined; readonly directories?: readonly unknown[] },
  probe: ExecutableProbe,
): Promise<string | undefined> {
  if (!isCommandName(name)) return undefined;
  for (const directory of searchDirectories(search.path, search.directories)) {
    const candidate = directory === '/' ? `/${name}` : `${directory}/${name}`;
    if (await probe(candidate).catch(() => false)) return candidate;
  }
  return undefined;
}
