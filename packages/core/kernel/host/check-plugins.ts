import { milliseconds } from '@ferretry/std';
import type { Clock, WorkersPort } from '../contract/ports.ts';
import type {
  CheckLine,
  DaemonImplementation,
  PreflightFacts,
  SelftestProbe,
} from '../manifest/implement.ts';
import type { TempDirs } from './adapters/temp-dir.ts';

/**
 * WHAT `fyd --check` ASKS OF THE PLUGINS (DECISIONS-2 #22): their pure preflight lines, their bounded selftests and the
 * kernel's own start-and-stop of every embedded worker. NOTHING HERE RUNS AT BOOT — `bootHost` never imports this file —
 * and nothing here creates home state: a selftest gets a temp directory of its own and no port, config or state.
 */

/** How long one selftest may take before the KERNEL calls it failed; a plugin cannot lengthen it. */
export const SELFTEST_TIMEOUT_MS = 20_000;
/** How long one worker may take to answer the probe (today's bundled-worker probe). */
export const WORKER_PROBE_TIMEOUT_MS = 20_000;
/** The most lines one preflight may add, and the longest a label or a line's text may be: a plugin cannot flood a report. */
const MAX_PREFLIGHT_LINES = 16;
const MAX_TEXT = 500;
const LABEL = /^[a-z][a-z0-9 -]{0,23}$/;
/** Labels the kernel's own lines use; a plugin line may not borrow one (`workers` is judged by the release smoke). */
const KERNEL_LABELS: ReadonlySet<string> = new Set(['state home', 'address', 'workers']);
/** The column the text starts in, matching the kernel's `state home   ` / `address      ` lines. */
const LABEL_WIDTH = 12;

type Say = (line: string) => void;

export interface PluginCheckDeps {
  readonly implementations: readonly DaemonImplementation[];
  readonly facts: PreflightFacts;
  readonly workers: WorkersPort;
  readonly tempDirs: TempDirs;
  readonly clock: Pick<Clock, 'after' | 'nowMs'>;
  readonly selftestTimeoutMs?: number;
  readonly workerTimeoutMs?: number;
}

/** One printed line. Control characters (a newline would forge a second line) become spaces; the text is capped. */
const printable = (text: string): string =>
  text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, MAX_TEXT);

const lineOf = (label: string, text: string): string => `${label.padEnd(LABEL_WIDTH)} ${printable(text)}`;
const firstLine = (error: unknown): string => printable(error instanceof Error ? error.message : String(error));

/** Remembers every label this run printed, so no plugin line can repeat or borrow one. */
function labelGate(say: Say): { readonly accept: (label: string) => boolean; readonly say: Say } {
  const taken = new Set<string>(KERNEL_LABELS);
  return {
    accept: label => LABEL.test(label) && !taken.has(label) && (taken.add(label), true),
    say,
  };
}

/** Runs every preflight, then every selftest, then starts every embedded worker; says each line as it is known. */
export async function runPluginChecks(deps: PluginCheckDeps, say: Say): Promise<void> {
  const gate = labelGate(say);
  for (const implementation of deps.implementations) runPreflights(implementation, deps.facts, gate);
  for (const implementation of deps.implementations) await runSelftests(implementation, deps, gate);
  await runWorkerProbes(deps, say);
}

function runPreflights(
  implementation: DaemonImplementation,
  facts: PreflightFacts,
  gate: ReturnType<typeof labelGate>,
): void {
  const plugin = implementation.manifest.id;
  for (const [id, run] of Object.entries(implementation.preflight ?? {})) {
    let lines: readonly CheckLine[];
    try {
      const answer: unknown = run({ ...facts });
      if (typeof (answer as { then?: unknown } | null)?.then === 'function')
        throw new TypeError('a preflight is synchronous and returned a promise');
      if (!Array.isArray(answer)) throw new TypeError('a preflight returns a list of lines');
      lines = (answer as readonly CheckLine[]).slice(0, MAX_PREFLIGHT_LINES);
    } catch (error) {
      gate.say(lineOf(plugin.slice(0, LABEL_WIDTH), `! preflight ${id} failed — ${firstLine(error)}`));
      continue;
    }
    for (const line of lines) {
      if (typeof line?.label !== 'string' || typeof line.text !== 'string' || !gate.accept(line.label)) {
        gate.say(lineOf(plugin.slice(0, LABEL_WIDTH), `! preflight ${id} returned a line with a missing, repeated or reserved label`));
        continue;
      }
      gate.say(lineOf(line.label, line.text));
    }
  }
}

async function runSelftests(
  implementation: DaemonImplementation,
  deps: PluginCheckDeps,
  gate: ReturnType<typeof labelGate>,
): Promise<void> {
  const plugin = implementation.manifest.id;
  for (const [id, probe] of Object.entries(implementation.selftest ?? {})) {
    if (!gate.accept(probe.label)) {
      gate.say(lineOf(plugin.slice(0, LABEL_WIDTH), `! selftest ${id} has a missing, repeated or reserved label`));
      continue;
    }
    gate.say(lineOf(probe.label, await runSelftest(probe, deps)));
  }
}

/** One selftest, bounded by the kernel, in a temp directory of its own that is removed whatever happens. */
async function runSelftest(probe: SelftestProbe, deps: PluginCheckDeps): Promise<string> {
  const timeoutMs = deps.selftestTimeoutMs ?? SELFTEST_TIMEOUT_MS;
  const abort = new AbortController();
  let tempDir: string | undefined;
  let cancel: (() => void) | undefined;
  try {
    tempDir = await deps.tempDirs.make();
    const timeout = new Promise<never>((_, reject) => {
      cancel = deps.clock.after(milliseconds(timeoutMs), () => {
        abort.abort();
        reject(new Error(`it did not finish within ${String(timeoutMs)} ms`));
      });
    });
    const answer = probe.run({ tempDir, signal: abort.signal, clock: deps.clock });
    // A selftest that fails after the timeout already answered must not become an unhandled rejection.
    answer.catch(() => {});
    return printable(await Promise.race([answer, timeout]));
  } catch (error) {
    return `! ${firstLine(error)}`;
  } finally {
    cancel?.();
    if (tempDir !== undefined) await deps.tempDirs.remove(tempDir).catch(() => {});
  }
}

// ─── the workers ──────────────────────────────────────────────────────────────────────────────────────────────────

interface WorkerReport {
  readonly name: string;
  readonly ready: boolean;
  readonly reason?: string;
}

/**
 * Starts the worker program with NO state grant and no `workerData` (so it can open nothing of the home), sends it
 * `{ probe: true }`, and ends it: ready when it answers `probe: true` (and no `ok: false`) inside the timeout.
 */
async function probeWorker(name: string, url: URL, deps: PluginCheckDeps): Promise<WorkerReport> {
  const timeoutMs = deps.workerTimeoutMs ?? WORKER_PROBE_TIMEOUT_MS;
  let handle: ReturnType<WorkersPort['start']>;
  try {
    handle = deps.workers.start(url, { name: `${name}-probe` });
  } catch (error) {
    return { name, ready: false, reason: `it could not be created: ${firstLine(error)}` };
  }
  const cancels: Array<() => void> = [];
  try {
    return await new Promise<WorkerReport>(resolve => {
      const settle = (report: WorkerReport): void => resolve(report);
      cancels.push(
        deps.clock.after(milliseconds(timeoutMs), () =>
          settle({ name, ready: false, reason: `no answer within ${String(timeoutMs)} ms` }),
        ),
        handle.onMessage(message => {
          const answer = message as { ok?: unknown; probe?: unknown } | null;
          settle(
            answer?.probe === true && answer.ok !== false
              ? { name, ready: true }
              : { name, ready: false, reason: 'it started but did not answer the probe' },
          );
        }),
        handle.onExit(exit =>
          settle({ name, ready: false, reason: `it failed: ${exit.reason === undefined ? `exit ${String(exit.code)}` : printable(exit.reason)}` }),
        ),
      );
      handle.post({ probe: true });
    });
  } finally {
    for (const cancel of cancels) cancel();
    await handle.terminate().catch(() => {});
  }
}

/** The `workers` line of `fyd --check`: every worker that started, or the first that did not and why (today's sentence). */
export function describeWorkerProbes(reports: readonly WorkerReport[]): string {
  const failed = reports.find(report => !report.ready);
  if (failed !== undefined) return `! ${failed.name} did not start — ${failed.reason ?? 'no reason was given'}`;
  return `${reports.map(report => report.name).join(', ')} ready`;
}

async function runWorkerProbes(deps: PluginCheckDeps, say: Say): Promise<void> {
  const reports: WorkerReport[] = [];
  for (const implementation of deps.implementations)
    for (const [id, url] of Object.entries(implementation.workers ?? {}))
      reports.push(await probeWorker(id, url, deps));
  if (reports.length > 0) say(lineOf('workers', describeWorkerProbes(reports)));
}
