/**
 * THE PLUGIN WORKER PROGRAMS A COMPILED DAEMON MUST HOLD.
 *
 * A plugin declares its worker thread programs in its manifest (`workers: [id]`) and names each one's module from its
 * daemon half (`workers: { [id]: new URL('../worker/x.worker.ts', import.meta.url) }`); `fyd --check` starts them. The
 * generated registry is the one list of halves, so this reads the workers from IT: nothing is hand-listed and no
 * directory is globbed. `scripts/release/compile-executable.ts` embeds each program as an extra entrypoint, FLAT beside
 * the entry under the name the kernel resolves it by (`embeddedWorkerFile`, packages/core/kernel/host/adapters/embedded-worker.ts).
 *
 * A declaration the compile cannot honour fails the COMPILE, with every problem named, rather than shipping a daemon
 * whose `fyd --check` prints `workers ! … did not start` and fails the release smoke after the fact.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddedWorkerFile } from '../../packages/core/kernel/host/adapters/embedded-worker.ts';

/** The slice of a daemon half this reads: the manifest's declared ids and the half's module URLs. */
export interface WorkerHalf {
  readonly manifest: { readonly id: string; readonly workers?: readonly string[] };
  readonly workers?: Readonly<Record<string, URL>>;
}

/** One worker program to embed. */
export interface PluginWorker {
  readonly plugin: string;
  readonly id: string;
  /** The source file the compile reads. */
  readonly source: string;
  /** The embedded file name (beside the entry). */
  readonly file: string;
}

/** The generated registry of the package an entry belongs to, when it has one: that entry hosts the plugins. */
export function pluginRegistryFor(entry: string, exists: (path: string) => boolean = existsSync): string | undefined {
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    if (exists(join(directory, 'package.json'))) {
      const registry = join(directory, 'src', 'generated', 'plugins.ts');
      return exists(registry) ? registry : undefined;
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/**
 * Every declared worker program, in a stable order. Throws one error naming every problem: a declared id the half does
 * not implement, an implemented id nobody declared, a module that is not a file on disk, and two programs (or one and
 * the entry, or one and a worker program beside the entry) that would embed under one name. `siblings` are the
 * embedded names of those workers beside the entry (`<stem>.js` of each `*.worker.ts` there): they land flat in the same
 * place, so a plugin worker with one of their stems would collide with it silently inside Bun.
 */
export function pluginWorkers(
  halves: readonly WorkerHalf[],
  entryFile: string,
  exists: (path: string) => boolean = existsSync,
  siblings: readonly string[] = [],
): readonly PluginWorker[] {
  const problems: string[] = [];
  const found: PluginWorker[] = [];
  for (const half of halves) {
    const plugin = half.manifest.id;
    const declared = half.manifest.workers ?? [];
    const implemented = half.workers ?? {};
    for (const id of declared)
      if (!(id in implemented))
        problems.push(`${plugin} declares worker "${id}" but its daemon half names no program for it`);
    for (const [id, url] of Object.entries(implemented)) {
      if (!declared.includes(id)) {
        problems.push(`${plugin}'s daemon half names worker "${id}" that its manifest does not declare`);
        continue;
      }
      if (url.protocol !== 'file:') {
        problems.push(`${plugin} worker "${id}" is ${url.href}, not a file the compile can embed`);
        continue;
      }
      const source = fileURLToPath(url);
      if (!exists(source)) {
        problems.push(`${plugin} worker "${id}" names ${source}, which does not exist`);
        continue;
      }
      found.push({ plugin, id, source, file: embeddedWorkerFile(url) });
    }
  }
  const owners = new Map<string, string>([
    ...siblings.map((file): [string, string] => [file, 'a worker program beside the entry']),
    [entryFile, 'the entry'],
  ]);
  for (const worker of found) {
    const earlier = owners.get(worker.file);
    if (earlier !== undefined)
      problems.push(
        `${worker.plugin} worker "${worker.id}" would embed as ${worker.file}, which ${earlier} already holds; a worker program's file name must be unique`,
      );
    else owners.set(worker.file, `${worker.plugin} worker "${worker.id}"`);
  }
  if (problems.length > 0) throw new Error(`the plugin workers cannot be embedded:\n  - ${problems.join('\n  - ')}`);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}
