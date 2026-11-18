import type { LoopPort } from '@ferretry/kernel/contract';
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
