import type { DaemonImplementation } from '../manifest/implement.ts';
import { embeddedWorkerFile } from './adapters/embedded-worker.ts';

/**
 * `fyd --plugin-child <program> [args…]`: THE DAEMON'S OWN EXECUTABLE, RUN AS A PLUGIN'S CHILD PROCESS. A plugin that must
 * keep native code out of the daemon (Voice's speech engines: a fault inside sherpa-onnx must not end `fyd`) starts a child
 * through its own spawn port, which lets it run `$daemon` and nothing else. A compiled `fyd` holds no other program to
 * start, so the child is `fyd` itself, told which of the plugin programs embedded beside the entry (the declared workers,
 * `scripts/release/plugin-workers.ts`) to run as the process's main program. It is answered BEFORE anything with a side effect
 * (no home, no lock, no port, no configuration, no secret: it never reads `FY_HOME`): the child is a program, not a second daemon.
 *
 * Only a declared worker program can be named, by its bare file stem (an ALLOWLIST: never a path, never a module specifier), exactly as `workersFor` limits a worker. The program
 * keeps the process (it reads its stdin and ends itself), so this answers only when it could not start one.
 */
export const PLUGIN_CHILD_FLAG = '--plugin-child';

/** `EX_USAGE`. */
const EXIT_USAGE = 64;

export async function runPluginChild(argv: readonly string[]): Promise<number> {
  const stem = argv[0];
  // An ALLOWLIST, not a lookup: a stem is a bare name, and only a worker program a plugin declared (and the compile embedded) can match it.
  if (stem === undefined || !/^[a-z][a-z0-9-]*$/u.test(stem)) return refuse(stem);
  // A LITERAL path, like the one `fyd` boots from: the compiled binary bundles only an import it can read.
  const registry = (await import('../src/generated/plugins.ts')) as unknown as {
    readonly daemonImplementations: readonly DaemonImplementation[];
  };
  const declared = registry.daemonImplementations
    .flatMap(half => Object.values(half.workers ?? {}))
    .find(candidate => embeddedWorkerFile(candidate) === `${stem}.js`);
  if (declared === undefined) return refuse(stem);
  // Beside the entry, flat, under the stem the registry just matched (`scripts/release/plugin-workers.ts` embeds it there). A compiled
  // binary is the only caller: from source a plugin starts its program by path, never through here.
  await import(`./${stem}.js`);
  // The program owns the process from here: it ends it (a closed stdin, a signal), so this never answers.
  return await new Promise<number>(() => undefined);
}

function refuse(stem: string | undefined): number {
  process.stderr.write(`${PLUGIN_CHILD_FLAG}: ${JSON.stringify(stem)} is not a program a plugin declared.\n`);
  return EXIT_USAGE;
}
