import type { LoopPort, WorkPort } from '@ferretry/kernel/contract';
import type { PerformanceProbe } from './recorder.ts';

/** A tick this late or later is a stall the profile names (v4's threshold; the report also counts blocks over 250 ms). */
export const STALL_RECORDED_MS = 100;

/**
 * THE EVENT-LOOP METER, HANDED TO THE PROFILE. The kernel ticks every quarter second and tells each observer how late the tick
 * fired; this feeds that into the probe, so a profile window reports ticks, lag percentiles and the stalls with the work that
 * was in flight (the boot step or the jobs still running).
 *
 * It costs nothing without a window: the observer returns on a boolean before touching a value, the kernel hands the same
 * labelling function to every tick, and the labels are built only for a tick that was a stall. Returns what stops the hearing.
 */
export function feedLoopToProbe(loop: Pick<LoopPort, 'observe'>, probe: PerformanceProbe): () => void {
  return loop.observe((lagMs, atMs, during) => {
    if (!probe.recording) return;
    probe.loopTick(lagMs);
    if (lagMs < STALL_RECORDED_MS) return;
    const labels = during();
    probe.stall({ atMs: atMs - lagMs, durationMs: lagMs, during: labels, innermost: labels, stacks: [] });
  });
}

/** What the kernel does not name: a file operation's path is not handed over, so every one reads as this. */
export const UNNAMED_PATH = '(path not reported)';

/**
 * THE KERNEL'S OWN WORK, HANDED TO THE PROFILE: the routes it served (by template), the programs it ran (by name) and the
 * host filesystem calls it made (by method), each with its wall time. Returns what stops the hearing.
 */
export function feedWorkToProbe(kernel: Pick<WorkPort, 'observeWork'>, probe: PerformanceProbe): () => void {
  return kernel.observeWork({
    route: (route, wallMs, status, bytes) => {
      if (probe.recording) probe.route(route, wallMs, status, bytes);
    },
    childStarted: program => {
      if (probe.recording) probe.childStarted(program, false);
    },
    childExited: (program, wallMs) => {
      if (probe.recording) probe.childExited(program, wallMs);
    },
    file: (operation, wallMs) => {
      if (probe.recording) probe.fileOperation(operation, UNNAMED_PATH, wallMs);
    },
  });
}
