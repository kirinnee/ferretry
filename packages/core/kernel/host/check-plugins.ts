import { type Duration, milliseconds } from '@ferretry/std';
import type { Clock, SpawnOptions, SpawnPort, WorkersPort } from '../contract/ports.ts';
import type { CheckLine, DaemonImplementation, PreflightFacts, SelftestProbe } from '../manifest/implement.ts';
import type { TempDirs } from './adapters/temp-dir.ts';
import type { SelftestConfigReader } from './check-config.ts';
import { effectivePermissions, NO_ITEMS, restrictSpawn, spawnPermitted } from './permissions.ts';
import { pluginStateFolder } from './roots.ts';

/**
 * WHAT `fyd --check` ASKS OF THE PLUGINS (DECISIONS-2 #22): their pure preflight lines, their bounded selftests and the
 * kernel's own start-and-stop of every embedded worker. NOTHING HERE RUNS AT BOOT — `bootHost` never imports this file —
 * and nothing here creates home state: a selftest gets a temp directory of its own and no port, config or state.
 */

/** How long one selftest may take before the KERNEL calls it failed; a plugin cannot lengthen it. */
const SELFTEST_TIMEOUT_MS = 20_000;
/** How long one worker may take to answer the probe (today's bundled-worker probe). */
const WORKER_PROBE_TIMEOUT_MS = 20_000;
/** The most lines one preflight may add, and the longest a label or a line's text may be: a plugin cannot flood a report. */
const MAX_PREFLIGHT_LINES = 16;
const MAX_TEXT = 500;
/** The column the text starts in, matching the kernel's `state home   ` / `address      ` lines. */
const LABEL_WIDTH = 12;
/**
 * A plugin's label: single-spaced lowercase words, no leading, trailing or repeated space, and short enough that
 * `lineOf` always pads it into the kernel's column (so no label can line up with, or spill past, a kernel label).
 */
const LABEL = /^[a-z][a-z0-9-]*( [a-z0-9-]+)*$/;
const MAX_LABEL = LABEL_WIDTH - 1;
/**
 * First words the kernel's own lines begin with. The release smoke `grep`s `^workers ` and `^webrtc ` and judges every
 * match, so a plugin label whose FIRST WORD is one of these is refused — `workers x` is as good a forgery as `workers`.
 * `plugin` and `plugins` are the labels the kernel prints its own failure lines under.
 */
const KERNEL_WORDS: ReadonlySet<string> = new Set(['state', 'address', 'workers', 'webrtc', 'plugin', 'plugins']);
/** The one reserved word a plugin may print: the `webrtc` line belongs to the engine selftest Connections declares. */
const WORD_OWNERS: ReadonlyMap<string, { readonly plugin: string; readonly selftest: string }> = new Map([
  ['webrtc', { plugin: 'connections', selftest: 'webrtc' }],
]);
/** What a plugin line is claimed by: the kernel decides from this, never from the plugin's own say-so. */
interface Claimant {
  readonly plugin: string;
  readonly kind: 'preflight' | 'selftest';
  readonly id: string;
}
/** The label the kernel prints a plugin's failure under: one it owns, so a plugin id can never shape the column. */
const FAILURE_LABEL = 'plugin';
/** What a selftest is handed when the check has no spawn adapter: every start is refused. */
const NO_SPAWN: SpawnPort = {
  run: () => Promise.reject(new Error('this check has no spawn adapter')),
  runBytes: () => Promise.reject(new Error('this check has no spawn adapter')),
  start: () => {
    throw new Error('this check has no spawn adapter');
  },
};
/**
 * A selftest's spawn: its plugin's declared programs only — and, when the probe names `programs`, only those of them
 * (a name the manifest does not declare grants nothing) — the selftest's abort signal on every child, never a cwd,
 * caller env or ferret.
 */
function boundSpawn(
  implementation: DaemonImplementation,
  base: SpawnPort,
  signal: AbortSignal,
  programs?: readonly string[],
): SpawnPort {
  const plugin = implementation.manifest.id;
  const declared = effectivePermissions(plugin, implementation.manifest.permissions?.spawn ?? []);
  const narrowed = restrictSpawn(
    plugin,
    programs === undefined ? declared : programs.filter(program => spawnPermitted(declared, NO_ITEMS, program)),
    base,
  );
  const options = <O extends SpawnOptions | undefined>(given: O): SpawnOptions => {
    const { cwd: _cwd, env: _env, forFerret: _ferret, signal: _signal, ...rest } = (given ?? {}) as SpawnOptions;
    return { ...rest, signal };
  };
  const bound: SpawnPort = {
    run: async (program, args, given) => await narrowed.run(program, args, options(given)),
    runBytes: async (program, args, given) => await narrowed.runBytes(program, args, options(given)),
    start: (program, args, given) => narrowed.start(program, args, options(given)),
  };
  return Object.freeze(bound);
}
/** The most a whole `--check` may take before the host stops it: each selftest and worker is bounded, plus slack. */
const DEADLINE_SLACK_MS = 20_000;

type Say = (line: string) => void;

export interface PluginCheckDeps {
  readonly implementations: readonly DaemonImplementation[];
  readonly facts: PreflightFacts;
  readonly workers: WorkersPort;
  readonly tempDirs: TempDirs;
  readonly clock: Pick<Clock, 'after' | 'nowMs'>;
  /** The unrestricted spawn adapter; each selftest gets it narrowed to its own plugin's `permissions.spawn`. Absent: nothing may run. */
  readonly spawn?: SpawnPort;
  /**
   * Reads a plugin's own config as in effect, for `SelftestProbe.enabledBy` (`inEffectConfigReader`). Absent: every
   * probe runs, as if each were switched on.
   */
  readonly config?: SelftestConfigReader;
  readonly selftestTimeoutMs?: number;
  readonly workerTimeoutMs?: number;
}

/** One printed line. Control characters (a newline would forge a second line) become spaces; the text is capped. */
const printable = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
    .slice(0, MAX_TEXT);

const lineOf = (label: string, text: string): string => `${label.padEnd(LABEL_WIDTH)} ${printable(text)}`;
const firstLine = (error: unknown): string => printable(error instanceof Error ? error.message : String(error));

/**
 * Remembers every label this run printed, so no plugin line can repeat one or borrow a kernel one. A reserved first
 * word is accepted only as exactly that word, from the plugin and selftest that own it.
 */
function labelGate(say: Say): {
  readonly accept: (label: unknown, claimant: Claimant) => label is string;
  readonly say: Say;
} {
  const taken = new Set<string>();
  const accept = (label: unknown, claimant: Claimant): label is string => {
    if (typeof label !== 'string' || label.length > MAX_LABEL || !LABEL.test(label) || taken.has(label)) return false;
    const word = label.split(' ')[0] ?? label;
    if (KERNEL_WORDS.has(word)) {
      const owner = WORD_OWNERS.get(word);
      const owned =
        owner !== undefined &&
        label === word &&
        claimant.kind === 'selftest' &&
        claimant.plugin === owner.plugin &&
        claimant.id === owner.selftest;
      if (!owned) return false;
    }
    taken.add(label);
    return true;
  };
  return { accept, say };
}

/**
 * Reads the plugin registry AFTER the home and address verdict is out. A registry that throws while it loads is one
 * line (`plugins      ! the plugin registry did not load — …`) and no plugin checks, never a crash of the check.
 */
export async function loadRegistry(
  load: () => Promise<readonly DaemonImplementation[]>,
  say: Say,
): Promise<readonly DaemonImplementation[] | undefined> {
  try {
    return await load();
  } catch (error) {
    say(lineOf('plugins', `! the plugin registry did not load — ${firstLine(error)}`));
    return undefined;
  }
}

/** How long a whole `--check` may take: every selftest and worker at its bound, plus slack. The host arms its exit with it. */
export function checkDeadlineMs(
  implementations: readonly DaemonImplementation[],
  timeouts: { readonly selftestTimeoutMs?: number; readonly workerTimeoutMs?: number } = {},
): number {
  let total = DEADLINE_SLACK_MS;
  for (const implementation of implementations) {
    total += Object.keys(implementation.selftest ?? {}).length * (timeouts.selftestTimeoutMs ?? SELFTEST_TIMEOUT_MS);
    total += Object.keys(implementation.workers ?? {}).length * (timeouts.workerTimeoutMs ?? WORKER_PROBE_TIMEOUT_MS);
  }
  return total;
}

/** Runs every preflight, then every selftest, then starts every embedded worker; says each line as it is known. */
export async function runPluginChecks(given: PluginCheckDeps, say: Say): Promise<void> {
  // The kernel's own timers and clock reading, taken ONCE here and frozen: nothing a selftest is handed can reach them.
  const deps: PluginCheckDeps = {
    ...given,
    clock: Object.freeze({
      nowMs: given.clock.nowMs.bind(given.clock),
      after: given.clock.after.bind(given.clock),
    }),
  };
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
      gate.say(lineOf(FAILURE_LABEL, `! ${plugin} preflight ${id} failed — ${firstLine(error)}`));
      continue;
    }
    for (const line of lines) {
      if (typeof line?.text !== 'string' || !gate.accept(line.label, { plugin, kind: 'preflight', id })) {
        gate.say(
          lineOf(
            FAILURE_LABEL,
            `! ${plugin} preflight ${id} returned a line with a missing, malformed, repeated or reserved label`,
          ),
        );
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
    if (!gate.accept(probe.label, { plugin, kind: 'selftest', id })) {
      gate.say(
        lineOf(FAILURE_LABEL, `! ${plugin} selftest ${id} has a missing, malformed, repeated or reserved label`),
      );
      continue;
    }
    const enabled = await selftestEnabled(probe, deps, implementation);
    if (enabled.kind === 'refused') {
      gate.say(lineOf(FAILURE_LABEL, `! ${plugin} selftest ${id} ${enabled.why}`));
      continue;
    }
    if (enabled.kind === 'off') {
      gate.say(lineOf(probe.label, enabled.text));
      continue;
    }
    gate.say(lineOf(probe.label, await runSelftest(probe, deps, implementation)));
  }
}

type Enabled =
  | { readonly kind: 'run' }
  | { readonly kind: 'off'; readonly text: string }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * `SelftestProbe.enabledBy` (kernel batch #14): whether the probe runs, judged by the KERNEL from the plugin's own file
 * as in effect. It fails toward checking: only an exact `false` from `on` over a value in effect switches it off.
 */
async function selftestEnabled(
  probe: SelftestProbe,
  deps: PluginCheckDeps,
  implementation: DaemonImplementation,
): Promise<Enabled> {
  const by = probe.enabledBy;
  if (by === undefined) return { kind: 'run' };
  const own = implementation.manifest.data?.config ?? [];
  if (by.def?.shape !== 'file' || !own.includes(by.def))
    return { kind: 'refused', why: 'is switched by a config file that is not one of its own declared files' };
  if (deps.config === undefined) return { kind: 'run' };
  let value: unknown;
  try {
    value = await deps.config.inEffect(implementation.manifest.id, by.def);
  } catch {
    return { kind: 'run' };
  }
  if (value === undefined) return { kind: 'run' };
  let on: unknown;
  try {
    on = by.on(value);
  } catch {
    return { kind: 'run' };
  }
  if (on !== false) return { kind: 'run' };
  const consequence = typeof by.consequence === 'string' && by.consequence !== '' ? ` — ${by.consequence}` : '';
  return { kind: 'off', text: `switched off in ${deps.facts.home}/config/${by.def.file}${consequence}` };
}

/** One selftest, bounded by the kernel, in a temp directory of its own that is removed whatever happens. */
async function runSelftest(
  probe: SelftestProbe,
  deps: PluginCheckDeps,
  implementation: DaemonImplementation,
): Promise<string> {
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
    // Its own frozen environment and clock: whatever it does to them, the kernel's timer above is a different function.
    const clock = Object.freeze({
      nowMs: () => deps.clock.nowMs(),
      after: (delay: Duration, fn: () => void) => deps.clock.after(delay, fn),
    });
    const answer = probe.run(
      Object.freeze({
        ...(probe.host === true
          ? {
              stateDir: pluginStateFolder(deps.facts.home, implementation.manifest.id),
              spawn: boundSpawn(implementation, deps.spawn ?? NO_SPAWN, abort.signal, probe.programs),
            }
          : {}),
        tempDir,
        signal: abort.signal,
        clock,
      }),
    );
    // A selftest that fails after the timeout already answered must not become an unhandled rejection.
    answer.catch(() => {});
    return printable(await Promise.race([answer, timeout]));
  } catch (error) {
    return `! ${firstLine(error)}`;
  } finally {
    cancel?.();
    // Answered or not, its children end with it: a child the probe started and left running is aborted here too.
    abort.abort();
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
    // No state grant, no workerData and an EMPTY environment: the probe thread sees nothing of the daemon's.
    handle = deps.workers.start(url, { name: `${name}-probe`, env: {} });
  } catch (error) {
    return { name, ready: false, reason: `it could not be created: ${firstLine(error)}` };
  }
  const cancels: Array<() => void> = [];
  try {
    return await new Promise<WorkerReport>(resolve => {
      const settle = (report: WorkerReport): void => resolve(report);
      // each cancel is kept as soon as it exists, so a later throw still disarms the timers made before it
      cancels.push(
        deps.clock.after(milliseconds(timeoutMs), () =>
          settle({ name, ready: false, reason: `no answer within ${String(timeoutMs)} ms` }),
        ),
      );
      cancels.push(
        handle.onMessage(message => {
          const answer = message as { ok?: unknown; probe?: unknown } | null;
          settle(
            answer?.probe === true && answer.ok !== false
              ? { name, ready: true }
              : { name, ready: false, reason: 'it started but did not answer the probe' },
          );
        }),
      );
      cancels.push(
        handle.onExit(exit =>
          settle({
            name,
            ready: false,
            reason: `it failed: ${exit.reason === undefined ? `exit ${String(exit.code)}` : printable(exit.reason)}`,
          }),
        ),
      );
      handle.post({ probe: true });
    });
  } catch (error) {
    // a handle that throws (post, onMessage, onExit) is a worker that did not start, not a crash of the check
    return { name, ready: false, reason: `its handle failed: ${firstLine(error)}` };
  } finally {
    for (const cancel of cancels) cancel();
    await Promise.resolve()
      .then(() => handle.terminate())
      .catch(() => {});
  }
}

/** The `workers` line of `fyd --check`: every worker that started, or the first that did not and why (today's sentence). */
function describeWorkerProbes(reports: readonly WorkerReport[]): string {
  const failed = reports.find(report => !report.ready);
  // The kernel owns the sentence: a failure ends in a full stop, so a reason that ends in " ready" can never satisfy the
  // smoke's `ready$` check for a worker that did not start.
  if (failed !== undefined) {
    const reason = (failed.reason ?? 'no reason was given').replace(/[.\s]+$/u, '');
    return `! ${failed.name} did not start — ${reason}.`;
  }
  return `${reports.map(report => report.name).join(', ')} ready`;
}

async function runWorkerProbes(deps: PluginCheckDeps, say: Say): Promise<void> {
  const reports: WorkerReport[] = [];
  for (const implementation of deps.implementations)
    for (const [id, url] of Object.entries(implementation.workers ?? {}))
      reports.push(await probeWorker(id, url, deps));
  if (reports.length > 0) say(lineOf('workers', describeWorkerProbes(reports)));
}
