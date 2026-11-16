/**
 * The ONE read-only line under the voice engine: how fast the chosen on-device engine runs here, picked
 * automatically per device (`lib/stt/speed-plan.ts`) — "Speech speed: standard (one core)" — with one
 * plain sentence of what that means for the person and one of why. No technical names on screen. There is nothing to press: the choice is the device's, and a path
 * that failed here is skipped on its own.
 *
 * Absent for Browser voice (the vendor's recognizer, nothing of ours runs).
 */

import { useEffect, useMemo, useReducer } from 'react';
import { onDeviceModel } from '../../lib/stt/model-catalog.ts';
import { type SpeedPlanner, speedPlannerFor } from '../../lib/stt/speed-planner.ts';
import { SPEED_CONSEQUENCE_TEXT, SPEED_REASON_TEXT, speedLine } from '../../lib/stt/speed-plan.ts';
import type { SpeedGlobalLike } from '../../lib/stt/speed-signals.ts';

export interface SpeedLineProps {
  /** The dictation engine id in use (`stt-settings.ts`); anything that is not an on-device model draws nothing. */
  readonly engine: string;
  /** Test and harness seam: the planner, instead of the page's own. */
  readonly planner?: SpeedPlanner;
}

export function SpeedLine({ engine, planner }: SpeedLineProps) {
  const pagePlanner = useMemo(() => planner ?? speedPlannerFor(globalThis as unknown as SpeedGlobalLike), [planner]);
  // The GPU is the one signal that needs a round trip; the line is right without it and redrawn with it.
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    let live = true;
    void pagePlanner.probe(globalThis as unknown as SpeedGlobalLike).then(() => {
      if (live) redraw();
    });
    return () => {
      live = false;
    };
  }, [pagePlanner]);
  const model = onDeviceModel(engine);
  if (model === null) return null;
  const plan = pagePlanner.planFor(model.id);
  return (
    <section aria-label="Speed" className="flex flex-col gap-1">
      <p className="m-0 text-ui font-semibold">{speedLine(plan)}</p>
      <p className="m-0 text-meta leading-base">{SPEED_CONSEQUENCE_TEXT[plan.path]}</p>
      <p className="m-0 text-meta leading-base text-muted">{SPEED_REASON_TEXT[plan.reason]}</p>
    </section>
  );
}
