/**
 * WHERE THE BUILD PUT THE DURIAN WORKER: the only module that names a bundler query (`?worker&url`), so a suite never imports
 * it (`durian-spawn.ts` loads it on first use, as Voice's `speech-assets.ts` is loaded). The worker is a same-origin module
 * worker built to `/assets/durian-worker-<hash>.js` (`vite.config.ts` › `worker`); the page's `fy-worker` Trusted Types policy
 * accepts exactly that shape and `worker-src 'self'` allows it, so no part of the page's policy had to be widened.
 */
import workerUrl from './durian-worker.ts?worker&url';

export default workerUrl;
