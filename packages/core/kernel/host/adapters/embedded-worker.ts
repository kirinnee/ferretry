/**
 * WHERE A PLUGIN'S WORKER THREAD PROGRAM IS, IN THE SOURCE TREE AND IN A COMPILED BINARY ALIKE.
 *
 * A plugin names its worker by URL, relative to its own module (`new URL('../worker/x.worker.ts', import.meta.url)`),
 * which finds the file only when run from source. In a compiled executable every module is bundled into one program
 * whose `import.meta.url` is the executable's embedded entry (`file:///$bunfs/root/fyd.js`), so the same line names a
 * file the binary does not hold (`file:///$bunfs/worker/x.worker.ts`) and the worker never starts.
 *
 * Two halves agree on one convention. `scripts/release/compile-executable.ts` embeds every worker program the generated
 * registry declares, FLAT beside the entry, as `<root>/<file stem>.js`; this resolves a worker URL to that embedded
 * file when running compiled, and leaves it alone otherwise. The file stem is the whole key (the directory the
 * spelling resolved to is not recoverable once bundled), so the compile step refuses two workers with one stem.
 */

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;

/** The embedded file name of the worker program at `url`: its file stem and `.js`. */
export function embeddedWorkerFile(url: URL): string {
  const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  return `${decodeURIComponent(name).replace(SOURCE_EXTENSION, '')}.js`;
}

/**
 * The URL to start the worker program `url` from. `moduleUrl` is this module's own unless a test asks how a compiled
 * binary would resolve it: a source module ends in `.ts`, a bundled one in `.js`. Compiled, EVERY worker URL resolves
 * to the embedded program beside the entry: a plugin's spelling is relative to the entry, so a deep one climbs out of the
 * executable's filesystem (`file:///a/b/x.ts`) and cannot be told from a real path by its look; the binary holds no
 * worker program anywhere else, so there is nothing else for the URL to mean.
 */
export function embeddedWorkerUrl(url: URL, moduleUrl: string = import.meta.url): URL {
  const compiled = !moduleUrl.endsWith('.ts');
  if (!compiled || url.protocol !== 'file:') return url;
  return new URL(`./${embeddedWorkerFile(url)}`, moduleUrl);
}
