import type { WorkerExtension } from './extensions.ts';

/**
 * THE PLUGIN WORKER EXTENSIONS this worker dispatches to. Empty as committed: `scripts/build-release.ts` replaces this
 * module's body at build time with an import of every `packages/{core,plugins}/<id>/app/worker.ts` (each a
 * `defineWorkerExtension(...)` default export), so the extensions are compiled into the signed `sw.verified.js` and
 * no code is fetched at run time. Its bundled initializer runs only AFTER the release listeners are registered.
 */
export const workerExtensions: readonly WorkerExtension[] = [];
