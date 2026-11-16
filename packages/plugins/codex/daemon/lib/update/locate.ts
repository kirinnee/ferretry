/**
 * Where Codex is on this host, and WHY it is that file.
 *
 * The ONE resolution rule, in the order an operator would expect it: what they named, then where they said to look, then
 * what this daemon happened to inherit. NOTHING IS LAUNCHED HERE. Every step is a lookup or a stat — see
 * {@link ExecutableResolverPort} — so this is safe to call from a report a browser asks for.
 *
 * The operator says it in one place, `config/harness-codex.yaml` (`binary`, `searchPaths`). A path written there is an
 * instruction rather than a preference: a `binary` this host cannot run is a stated failure that names the key to fix,
 * and nothing else is searched, because falling back would find some other `codex`, report a success, and leave them
 * believing they had configured something they had not.
 */
import type { ExecutableResolverPort, HarnessLocation } from './ports.ts';

/** The words of `config/harness-codex.yaml` this rule reads. */
export interface HarnessPaths {
  /** The exact file to run; absent means 'search for it'. */
  readonly binary?: string | undefined;
  /** Directories to look in, in order, on top of what the daemon inherited. */
  readonly searchPaths: readonly string[];
}

/** A `~` path as the operator means it. Absolute paths are returned untouched. */
function expandedHome(value: string, homeDirectory: string): string {
  if (value === '~') return homeDirectory;
  if (!value.startsWith('~/')) return value;
  return `${homeDirectory.replace(/\/+$/u, '')}/${value.slice(2)}`;
}

const candidateIn = (directory: string, name: string): string => `${directory.replace(/\/+$/u, '')}/${name}`;

const BINARY_KEY = 'harness-codex.yaml binary';
const SEARCH_PATHS_KEY = 'harness-codex.yaml searchPaths';

export async function locateCodex(
  paths: HarnessPaths,
  executables: ExecutableResolverPort,
  homeDirectory: string,
): Promise<HarnessLocation> {
  const binary = paths.binary?.trim();
  if (binary !== undefined && binary !== '') {
    const path = expandedHome(binary, homeDirectory);
    if (await executables.runnable(path))
      return { outcome: 'located', path, rule: 'explicit override', declaredBy: BINARY_KEY };
    return {
      outcome: 'override-absent',
      path,
      declaredBy: BINARY_KEY,
      reason: `${BINARY_KEY} names ${path} for codex and this host cannot run that file — nothing else was searched, because a path somebody wrote down is an instruction rather than a preference; correct it or remove it`,
    };
  }
  const directories = paths.searchPaths.map(entry => expandedHome(entry.trim(), homeDirectory));
  for (const directory of directories) {
    const candidate = candidateIn(directory, 'codex');
    if (await executables.runnable(candidate))
      return { outcome: 'located', path: candidate, rule: 'extra search path', declaredBy: SEARCH_PATHS_KEY };
  }
  const inherited = await executables.resolve('codex');
  if (inherited !== undefined)
    return { outcome: 'located', path: inherited, rule: 'inherited environment', declaredBy: 'PATH' };
  return { outcome: 'absent', searched: directories };
}
