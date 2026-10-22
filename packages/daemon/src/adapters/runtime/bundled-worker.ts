/**
 * WHERE A WORKER THREAD'S PROGRAM IS, IN THE SOURCE TREE AND IN A COMPILED BINARY ALIKE.
 *
 * A worker's program is a file of its own — `packages/daemon/bin/<name>.worker.ts` — and the obvious
 * `new Worker(new URL('../../../bin/x.ts', import.meta.url))` finds it only when run from source. In a
 * compiled executable every module is bundled into one program whose `import.meta.url` is the
 * executable's embedded root (`file:///$bunfs/root/fyd.js`), so that URL names a file the binary does
 * not hold, and the worker never starts: the PDF unlock shipped that way in every release.
 *
 * Two halves agree on one convention. `scripts/release/compile-executable.ts` embeds every
 * `bin/*.worker.ts` beside the entry it compiles, as `<root>/<name>.worker.js`; this resolves a worker
 * by the same name to that embedded file when compiled, and to the source file otherwise. `fyd --check`
 * starts each one, and the release smoke asserts it on every target.
 */

/** The bundled worker programs, by name: each is `packages/daemon/bin/<name>.worker.ts`. */
export type BundledWorkerName = 'analytics-fold' | 'housekeeping' | 'pdf-decrypt' | 'session';

/**
 * The URL to start the worker `name` from. `moduleUrl` is this module's own unless a test asks how a
 * compiled binary would resolve it.
 */
export function bundledWorkerUrl(name: BundledWorkerName, moduleUrl: string = import.meta.url): string {
  return moduleUrl.endsWith('.ts')
    ? new URL(`../../../bin/${name}.worker.ts`, moduleUrl).href
    : new URL(`./${name}.worker.js`, moduleUrl).href;
}

/** What starting one bundled worker proved. */
export interface WorkerProbeReport {
  readonly name: BundledWorkerName;
  readonly ready: boolean;
  /** Why it is not ready; absent when it is. */
  readonly reason?: string;
}

/**
 * The `workers` line of `fyd --check`: every worker that started, or the first that did not and why.
 * The release smoke greps for `ready` on every target, so the wording of success is part of the contract.
 */
export function describeWorkerProbes(reports: readonly WorkerProbeReport[]): string {
  const failed = reports.find(report => !report.ready);
  if (failed !== undefined) return `! ${failed.name} did not start — ${failed.reason ?? 'no reason was given'}`;
  return `${reports.map(report => report.name).join(', ')} ready`;
}

/**
 * Starts the worker `name`, sends it `{ probe: true }`, and ends it: ready when it answers with
 * `probe: true` (and no `ok: false`) inside `timeoutMs`. Each worker program answers that message.
 */
export async function probeBundledWorker(
  name: BundledWorkerName,
  {
    timeoutMs = 20_000,
    spawn = () => new Worker(bundledWorkerUrl(name), { type: 'module' }),
  }: {
    readonly timeoutMs?: number;
    readonly spawn?: () => Worker;
  } = {},
): Promise<WorkerProbeReport> {
  let worker: Worker;
  try {
    worker = spawn();
  } catch (error) {
    return {
      name,
      ready: false,
      reason: `it could not be created: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    return await new Promise<WorkerProbeReport>(resolve => {
      const timeout = setTimeout(
        () => resolve({ name, ready: false, reason: `no answer within ${String(timeoutMs)} ms` }),
        timeoutMs,
      );
      const settle = (report: WorkerProbeReport): void => {
        clearTimeout(timeout);
        resolve(report);
      };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const answer = event.data as { ok?: unknown; probe?: unknown } | null;
        settle(
          answer?.probe === true && answer.ok !== false
            ? { name, ready: true }
            : { name, ready: false, reason: 'it started but did not answer the probe' },
        );
      };
      worker.onerror = event => settle({ name, ready: false, reason: `it failed: ${event?.message ?? 'no detail'}` });
      worker.postMessage({ probe: true });
    });
  } finally {
    worker.terminate();
  }
}
