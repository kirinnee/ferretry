/**
 * FIRST RUN › THIS DEVICE › "Make clean-up faster" — the optional Groq / Cerebras keys this BROWSER holds (side client),
 * shown only after a LOCAL engine was picked on the Voice step.
 *
 * Why only then: the keys speed up the clean-up of dictated text, which only exists when dictation is on and an engine is
 * chosen. A person who picked Off, the browser's voice or nothing has no use for them yet, so the page decides on its own
 * to stay out of the way (`skip('not-needed')`), and the shell draws nothing and moves on. The keys themselves are the same
 * write-only card Settings › Voice draws (`speedup-keys-settings.tsx`): pasted once, sealed in this browser, never shown
 * again and never sent to a machine.
 */

import { useEffect } from 'react';
import { isOnDeviceEngine, type SttSettings } from '../../lib/stt/stt-settings.ts';
import { SpeedupKeysSettings } from '../settings/speedup-keys-settings.tsx';
import type { StepHost } from './step-host.ts';
import { useStepReady } from './use-step-ready.ts';

export const SPEEDUPS_STEP_TITLE = 'Make clean-up faster';
const SPEEDUPS_STEP_LINE = 'Optional. You can skip this and add a key later in Settings › Voice.';

/** Whether the page has anything to say: dictation is on and a local engine was picked. */
export const needsSpeedups = (settings: SttSettings): boolean => settings.enabled && isOnDeviceEngine(settings.engine);

export function SpeedupsStep({
  settings,
  step,
}: {
  readonly settings: SttSettings;
  readonly step?: StepHost | undefined;
}) {
  const needed = needsSpeedups(settings);
  useEffect(() => {
    if (!needed) step?.skip('not-needed');
  }, [needed, step]);
  useStepReady(needed ? step : undefined);
  if (!needed) return null;
  return (
    <section className="fy-voice-step" aria-labelledby="fy-speedups-step-title">
      <h2 id="fy-speedups-step-title" className="fy-voice-step-title">
        {SPEEDUPS_STEP_TITLE}
      </h2>
      <p className="fy-voice-step-line">{SPEEDUPS_STEP_LINE}</p>
      <SpeedupKeysSettings />
    </section>
  );
}
