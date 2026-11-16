/**
 * LET ONNX RUNTIME'S THREADS START under Trusted Types — and nothing else.
 *
 * The page's policy says `require-trusted-types-for 'script'` (`public/_headers`), and a speech worker
 * inherits it. With more than one thread ONNX Runtime Web builds its thread pool by constructing sub-workers
 * itself, and a plain URL string at `new Worker(…)` is refused: "This document requires 'TrustedScriptURL'
 * assignment". Measured (docs/voice.md › Speed): on an isolated page that error is the ONLY thing between
 * the page policy and working threads — `worker-src 'self'` already allows the sub-workers, because ONNX
 * Runtime starts each one from the speech worker's OWN script, `/assets/parakeet-worker-<hash>.js`.
 *
 * So the speech workers wrap their `Worker` constructor once: a URL on this origin that is one of the
 * app's own speech worker scripts (`trusted-types.ts` `isSpeechWorkerScriptUrl`, the speech half of the list
 * the page's own `fy-worker` policy enforces) is passed through that policy; ANYTHING else is handed on unchanged, where
 * the browser refuses it exactly as before. No new policy name is created, no URL outside the list is ever
 * blessed, and a single-thread run never constructs a worker, so it never notices.
 */

import { isSpeechWorkerScriptUrl, trustedWorkerUrl } from '../../shell-voice.ts';

type WorkerConstructor = new (url: unknown, options?: unknown) => unknown;

/** The slice of a worker's global this module reads and replaces. */
export interface ThreadScopeLike {
  Worker: WorkerConstructor;
  readonly location: { readonly href: string; readonly origin: string };
}

/**
 * The URL to hand `Worker`: the trusted form when it is one of the app's own speech worker scripts on this
 * origin, the original otherwise. Total: a URL that cannot be parsed, or that the policy refuses, is returned
 * as it came.
 */
export const vetThreadUrl = (
  url: unknown,
  scope: Pick<ThreadScopeLike, 'location'>,
  trust: (path: string) => string = trustedWorkerUrl,
): unknown => {
  try {
    const parsed = new URL(String(url), scope.location.href);
    if (parsed.origin !== scope.location.origin) return url;
    const path = `${parsed.pathname}${parsed.search}`;
    // Only the speech workers: the page's policy also knows the service worker, which no thread starts.
    return isSpeechWorkerScriptUrl(path) ? trust(path) : url;
  } catch {
    return url;
  }
};

/**
 * Wrap `scope.Worker` so ONNX Runtime's sub-workers can start. Idempotent per scope. Call before the first
 * inference session is created.
 */
export function allowSpeechThreads(scope: ThreadScopeLike, trust: (path: string) => string = trustedWorkerUrl): void {
  const Native = scope.Worker;
  if ((Native as { fySpeechThreads?: true }).fySpeechThreads === true) return;
  class SpeechThreadWorker extends (Native as new (url: unknown, options?: unknown) => object) {
    static readonly fySpeechThreads = true as const;
    constructor(url: unknown, options?: unknown) {
      super(vetThreadUrl(url, scope, trust), options);
    }
  }
  scope.Worker = SpeechThreadWorker as unknown as WorkerConstructor;
}
