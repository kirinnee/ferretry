/**
 * FIRST RUN › THIS DEVICE › "Speed-ups" — the optional Groq / Cerebras keys this BROWSER holds (side client),
 * shown only after a LOCAL engine was picked on the Voice step.
 *
 * Why only then: the keys speed up the clean-up of dictated text, which only exists when dictation is on and an engine is
 * chosen. A person who picked Off, the browser's voice or nothing has no use for them yet, so the page decides on its own
 * to stay out of the way (`skip('not-needed')`), and the shell draws nothing and moves on. The keys themselves are the same
 * write-only card Settings › Voice draws (`speedup-keys-settings.tsx`): pasted once, sealed in this browser, never shown
 * again and never sent to a machine. A saved key answers the step (`done()`), and nothing else does: a failed save, a Test, a
 * Remove or merely looking leaves it open, so the shell asks again only until a key is really saved.
 *
 * Layout (r11 O12): one line, the key cards stacked on the left and a picture of the clean-up on the right (`StepDemo`). The
 * keys have no pick to save with Next: a key is sealed by its own card's Save, the card's controls being the page's only buttons.
 */

import { StepDemo } from '@ferretry/app';
import { useEffect } from 'react';
import type { DeviceSpeedupKeys } from '../../lib/stt/speedup-keys.ts';
import { isOnDeviceEngine, type SttSettings } from '../../lib/stt/stt-settings.ts';
import { SpeedupKeysSettings } from '../settings/speedup-keys-settings.tsx';
import type { StepHost } from '@ferretry/kernel/contract';
import { SpeedupsDemo } from './speedups-demo.tsx';
import { useStepReady } from './use-step-ready.ts';
import './voice-step.css';

const SPEEDUPS_STEP_LINE = 'Optional. Keys make clean-up faster. Add one later in Settings › Voice.';

/** Whether the page has anything to say: dictation is on and a local engine was picked. */
export const needsSpeedups = (settings: SttSettings): boolean => settings.enabled && isOnDeviceEngine(settings.engine);

export function SpeedupsStep({
  settings,
  step,
  keys,
}: {
  readonly settings: SttSettings;
  readonly step?: StepHost | undefined;
  /** This device's key vault; the app store's when left out (a suite hands its own). */
  readonly keys?: DeviceSpeedupKeys | null;
}) {
  const needed = needsSpeedups(settings);
  useEffect(() => {
    if (!needed) step?.skip('not-needed');
  }, [needed, step]);
  useStepReady(needed ? step : undefined);
  if (!needed) return null;
  return (
    <section className="fy-voice-step" aria-label="Speed-ups" data-speedups-step="">
      <p className="fy-voice-step-line">{SPEEDUPS_STEP_LINE}</p>
      <SpeedupKeysSettings keys={keys} onSaved={() => step?.done()} />
      <StepDemo>
        <SpeedupsDemo />
      </StepDemo>
    </section>
  );
}
