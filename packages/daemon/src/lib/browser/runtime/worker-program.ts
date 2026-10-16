/**
 * Where the browser worker program lives, decided from facts the composition root reads.
 *
 * Every release channel installs the worker as an executable BESIDE the daemon: the archive, the
 * Homebrew cask, the deb/rpm packages and the one-line installer all carry it under its bin name,
 * and the compile output (`dist/bin`, `prebuilt/`) carries it with the release target suffix. A
 * daemon run from source has no compiled worker and runs the TypeScript worker through Node.
 *
 * A COMPILED daemon with no worker beside it is a broken install, and it says so as one plain
 * sentence rather than falling back to a TypeScript path that only exists in a source checkout —
 * that fallback is what used to surface as "this daemon runs no browser worker" with no remedy.
 */

/** The worker's executable name — the daemon package's second bin key. */
export const BROWSER_WORKER_NAME = 'fyd-browser-worker';

export type BrowserWorkerProgram =
  | { readonly kind: 'executable'; readonly path: string }
  | { readonly kind: 'source'; readonly entry: string }
  | { readonly kind: 'missing'; readonly message: string };

export interface BrowserWorkerSearch {
  /** `FY_BROWSER_WORKER_SOURCE`: run this TypeScript worker through Node (tests, development). */
  readonly sourceOverride?: string;
  /** `FY_BROWSER_WORKER_BIN`: run this compiled worker (release smoke, unusual layouts). */
  readonly binaryOverride?: string;
  /** Directories that may hold the daemon's own executable — as invoked and as resolved. */
  readonly executableDirectories: readonly string[];
  readonly platform: string;
  readonly arch: string;
  /** The TypeScript worker beside a source checkout's composition root; undefined when compiled. */
  readonly sourceEntry?: string;
  readonly exists: (path: string) => boolean;
}

/** The release target suffix compile.sh gives an artifact, for the platforms that ship. */
export function releaseTargetSuffix(platform: string, arch: string): string | undefined {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-baseline';
  return undefined;
}

/** Installed name first, then the compile-output name, in each directory in order. */
export function browserWorkerCandidates(
  directories: readonly string[],
  platform: string,
  arch: string,
): readonly string[] {
  const suffix = releaseTargetSuffix(platform, arch);
  const names =
    suffix === undefined ? [BROWSER_WORKER_NAME] : [BROWSER_WORKER_NAME, `${BROWSER_WORKER_NAME}-${suffix}`];
  const unique = [
    ...new Set(directories.map(directory => directory.replace(/\/+$/, '')).filter(directory => directory.length > 0)),
  ];
  return unique.flatMap(directory => names.map(name => `${directory}/${name}`));
}

export function selectBrowserWorker(search: BrowserWorkerSearch): BrowserWorkerProgram {
  const source = search.sourceOverride?.trim();
  if (source) return { kind: 'source', entry: source };
  const forced = search.binaryOverride?.trim();
  if (forced) return { kind: 'executable', path: forced };
  const found = browserWorkerCandidates(search.executableDirectories, search.platform, search.arch).find(search.exists);
  if (found !== undefined) return { kind: 'executable', path: found };
  if (search.sourceEntry !== undefined && search.exists(search.sourceEntry)) {
    return { kind: 'source', entry: search.sourceEntry };
  }
  return {
    kind: 'missing',
    message: `This machine's Ferretry install has no browser worker (${BROWSER_WORKER_NAME} is missing beside the daemon); reinstall or upgrade Ferretry to get it.`,
  };
}
