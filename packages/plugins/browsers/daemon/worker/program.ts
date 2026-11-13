/**
 * Where the browser worker program lives, decided from facts the daemon half reads (today's
 * `lib/browser/runtime/worker-program.ts`, copied).
 *
 * Every release channel installs the worker as an executable BESIDE the daemon: the archive, the
 * Homebrew cask, the deb/rpm packages and the one-line installer all carry it under its bin name,
 * and the compile output (`dist/bin`, `prebuilt/`) carries it with the release target suffix. A
 * daemon run from source has no compiled worker and runs the TypeScript worker through Node.
 *
 * A COMPILED daemon with no worker beside it is a broken install, and it says so as one plain
 * sentence rather than falling back to a TypeScript path that only exists in a source checkout.
 */

/** The worker's executable name (today's daemon package's second bin key). */
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
  /** The TypeScript worker entry in a source checkout (`./main.ts`); undefined when compiled. */
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

/** Every name the worker executable ships under: the manifest's `permissions.spawn` lists exactly these. */
export const BROWSER_WORKER_NAMES: readonly string[] = [
  BROWSER_WORKER_NAME,
  `${BROWSER_WORKER_NAME}-darwin-arm64`,
  `${BROWSER_WORKER_NAME}-linux-arm64`,
  `${BROWSER_WORKER_NAME}-linux-x64-baseline`,
];

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

/**
 * The flags Node runs the SOURCE worker with. Node's default type stripping refuses TypeScript parameter properties,
 * which the kernel and Vault contracts the worker imports use, so the source worker asks Node to transform types.
 */
export const NODE_WORKER_FLAGS: readonly string[] = ['--experimental-transform-types', '--no-warnings'];

/**
 * The command that starts the worker with `args` after it: the compiled worker directly, or Node over the source
 * entry. A source worker with no Node on this host, or a missing install, is the sentence that says so.
 */
export function workerCommand(
  program: BrowserWorkerProgram,
  node: string | undefined,
): { readonly program: string; readonly args: readonly string[] } | { readonly refused: string } {
  if (program.kind === 'missing') return { refused: program.message };
  if (program.kind === 'executable') return { program: program.path, args: [] };
  if (node === undefined)
    return { refused: 'The browser worker runs under Node in a source checkout, and no node is on this host’s PATH.' };
  return { program: node, args: [...NODE_WORKER_FLAGS, program.entry] };
}
