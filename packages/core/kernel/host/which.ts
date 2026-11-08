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

// locate ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One operator override variable a manifest may declare: `FY_` and a short upper-case name. */
const OVERRIDE_VARIABLE = /^FY_[A-Z0-9_]{1,60}$/u;

/** Whether `variable` is one this plugin declared in `permissions.whichOverrides`, by exact name and grammar. */
export function mayReadOverride(declared: readonly unknown[] | undefined, variable: unknown): variable is string {
  return (
    typeof variable === 'string' &&
    OVERRIDE_VARIABLE.test(variable) &&
    Array.isArray(declared) &&
    declared.some(entry => entry === variable)
  );
}

/** What `locateCommand` needs from its host: the one variable's value, the daemon's PATH and the probe. */
export interface LocateSources {
  /** The operator's value of the ONE declared variable asked for; never called with any other name. */
  readonly variable: (name: string) => string | undefined;
  readonly path: string | undefined;
  readonly probe: ExecutableProbe;
}

/** The answer of {@link locateCommand}; the same shape as the contract's `CommandLocation`. */
export type LocatedCommand =
  | { readonly kind: 'found'; readonly path: string; readonly via: 'override' | 'path' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'override_unusable'; readonly variable: string; readonly path: string };

/**
 * `kernel.paths.locate` (today's `CloudflaredLocator`, narrowed): the override variable's value, trimmed, when set and
 * not blank, else {@link whichCommand}. A set override is the answer only when it is an absolute, plain path whose
 * basename is `name` and the probe accepts it; anything else is `override_unusable` and the PATH is NOT searched,
 * because the operator named a binary and a different one found on PATH would leave them believing the opposite. The
 * caller has already been checked to have declared `override` ({@link mayReadOverride}); nothing is executed.
 */
export async function locateCommand(
  name: unknown,
  options: { readonly override: string; readonly directories?: readonly unknown[] },
  sources: LocateSources,
): Promise<LocatedCommand> {
  if (!isCommandName(name)) return { kind: 'absent' };
  const named = sources.variable(options.override)?.trim();
  if (named !== undefined && named !== '') {
    const plain = searchable(named);
    const basename = plain?.slice(plain.lastIndexOf('/') + 1);
    const usable =
      plain !== undefined && plain === named && basename === name && (await sources.probe(plain).catch(() => false));
    return usable
      ? { kind: 'found', path: named, via: 'override' }
      : { kind: 'override_unusable', variable: options.override, path: named };
  }
  const found = await whichCommand(name, { path: sources.path, directories: options.directories ?? [] }, sources.probe);
  return found === undefined ? { kind: 'absent' } : { kind: 'found', path: found, via: 'path' };
}

// whichFor ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The answer of {@link whichForCommand}; the same shape as the contract's `HandleCommandLookup`. */
export type HandleLookup =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unprovable' };

/** The plugins whose minted handles `plugin` may search: itself, and each plugin that offers a hook `plugin` takes. */
export function handleReaders(
  plugin: string,
  manifests: readonly {
    readonly id: string;
    readonly hooks?: {
      readonly offers?: readonly { readonly hook: { readonly name: string } }[];
      readonly takes?: readonly { readonly hook: { readonly name: string } }[];
    };
  }[],
): readonly string[] {
  const taken = new Set(
    manifests.find(manifest => manifest.id === plugin)?.hooks?.takes?.map(take => take.hook.name) ?? [],
  );
  const senders = manifests
    .filter(manifest => manifest.id !== plugin)
    .filter(manifest => (manifest.hooks?.offers ?? []).some(offer => taken.has(offer.hook.name)))
    .map(manifest => manifest.id);
  return Object.freeze([plugin, ...senders]);
}

/**
 * `kernel.paths.whichFor`: {@link whichCommand} on the PATH a Vault handle WILL set, and on nothing else (the daemon's
 * own PATH is not searched: a pane whose handle sets PATH sees that one). `searchPath` is the Vault's answer for this
 * plugin's readers; `undefined` (a foreign, forged, spent or secret-derived handle, or one that sets no PATH) is
 * `unprovable`, never `absent`, so a guard that must prove a negative fails closed. A PATH with no folder this lookup
 * may search is `unprovable` too. The PATH itself never leaves.
 */
export async function whichForCommand(
  name: unknown,
  searchPath: string | undefined,
  probe: ExecutableProbe,
): Promise<HandleLookup> {
  if (typeof searchPath !== 'string' || searchDirectories(searchPath).length === 0) return { kind: 'unprovable' };
  const found = await whichCommand(name, { path: searchPath }, probe);
  return found === undefined ? { kind: 'absent' } : { kind: 'found', path: found };
}
