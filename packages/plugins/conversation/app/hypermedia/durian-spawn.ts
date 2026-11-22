import { trustedWorkerUrl } from '@ferretry/app/ui';
import type { WorkerLike } from './durian-reader.ts';

/**
 * STARTS THE DURIAN WORKER, as the page does: the build's own URL for it (loaded on first use, because the module that holds it
 * names a bundler query), made a Trusted Types script URL by the shell's `fy-worker` policy, and run as a MODULE worker (the
 * chunk imports Durian's parser as modules). The reader (`durian-reader.ts`) takes this as its `spawn`, which is why the reader
 * itself can be tested without a bundler or a browser.
 */
export async function spawnDurianWorker(): Promise<WorkerLike> {
  const { default: url } = await import('./durian-worker-url.ts');
  return new Worker(trustedWorkerUrl(url), { type: 'module', name: 'fy-durian' });
}
