/**
 * FIRST RUN › THIS DEVICE › "Voice" — the engine cards as a stacked list on the left, a picture of what dictation does with
 * the pick on the right (`StepDemo`), one line of words.
 *
 * A client step (`voice`, side client): it configures THIS browser (`fy:voice:stt-settings`), so it is asked once per device,
 * whichever daemon the person paired first. It shows at once (`ready()`); there is nothing to check first. The shell owns the
 * frame (the title, Back / Later / Next), so the page draws no title and no button of its own.
 *
 *   - What the device already holds is chosen on arrival; with nothing held, Parakeet 110M (this device's default, `engine-defaults.ts`)
 *     when this browser can run it.
 *   - A pick only REGISTERS the write (`step.commit`, contract rule 8): nothing is saved by a click or an arrow key. Next saves
 *     the pick on this device (Off switches dictation off and keeps the engine, exactly as the Dictation switch in Settings ›
 *     Voice does) and answers the step. A pick equal to what the device already holds saves nothing.
 *   - Choosing never downloads. A card's own Install button does, and while it runs the step is busy (`busy(label)`), so
 *     Next waits for it.
 *   - The list is short on purpose: this device's default first, then the fastest, a balanced one, the browser's own and
 *     Off. "Show every engine" (a disclosure, not a button) opens the whole catalog, the same cards Settings › Voice draws.
 */

import { StepDemo } from '@ferretry/app';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SttSettings, SttSettingsPatch } from '../../lib/stt/stt-settings.ts';
import type { BrowserRecognitionSupport } from '../../lib/stt/browser-recognition.ts';
import { DEFAULT_ON_DEVICE_ENGINE, type DeviceClass } from '../../lib/stt/engine-defaults.ts';
import { ON_DEVICE_MODELS, type OnDeviceModel, type OnDeviceModelId } from '../../lib/stt/model-catalog.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import { EngineCardGrid, type EngineChoice } from '../engine-card/engine-card-grid.tsx';
import type { StepHost } from '@ferretry/kernel/contract';
import { VoiceDemo } from './voice-demo.tsx';
import { useStepReady } from './use-step-ready.ts';
import './voice-step.css';

const VOICE_STEP_LINE = 'Chosen for this device only. Nothing downloads until you press Install.';

/** The few engines the short list shows, in order: the device's default, then the fastest and a balanced one. */
export const shortListOf = (device: DeviceClass): readonly OnDeviceModelId[] => [
  ...new Set<OnDeviceModelId>([DEFAULT_ON_DEVICE_ENGINE[device], 'sherpa-zipformer-en', 'moonshine-base-en']),
];

/** What the cards show as chosen: Off when dictation is off, else the engine (or nothing before a choice). */
export const choiceOf = (settings: SttSettings): EngineChoice | null => (settings.enabled ? settings.engine : 'off');

/** The patch a card press writes. */
export const patchFor = (choice: EngineChoice): SttSettingsPatch =>
  choice === 'off' ? { enabled: false } : { enabled: true, engine: choice };

export interface VoiceStepProps {
  readonly settings: SttSettings;
  update(patch: SttSettingsPatch): void;
  readonly voices: OnDeviceVoices | null;
  readonly browserSupport: BrowserRecognitionSupport;
  readonly deviceClass: DeviceClass;
  readonly step?: StepHost | undefined;
}

export function VoiceStep({ settings, update, voices, browserSupport, deviceClass, step }: VoiceStepProps) {
  useStepReady(step);
  const [all, setAll] = useState(false);
  const saved = choiceOf(settings);
  // Until a card is pressed the pick is what the device holds, and nothing held yet reads as this device's default, shown
  // chosen so Next accepts it, when this browser can run it (a default that cannot run here is never chosen for anyone).
  const [pressed, setPick] = useState<EngineChoice | null>(null);
  const defaultEngine = DEFAULT_ON_DEVICE_ENGINE[deviceClass];
  const pick = pressed ?? saved ?? (voices?.get(defaultEngine)?.support.available === true ? defaultEngine : null);
  const writer = useRef(update);
  writer.current = update;
  // What Next saves follows the pick; a pick that is what the device already holds saves nothing.
  useEffect(() => {
    step?.commit(
      pick === null || pick === saved
        ? null
        : async () => {
            writer.current(patchFor(pick));
          },
    );
  }, [pick, saved, step]);
  const models = useMemo((): readonly OnDeviceModel[] => {
    if (all) return ON_DEVICE_MODELS;
    const wanted = shortListOf(deviceClass);
    return wanted.flatMap(id => ON_DEVICE_MODELS.filter(model => model.id === id));
  }, [all, deviceClass]);
  return (
    <section className="fy-voice-step" aria-label="Voice" data-voice-step="">
      <EngineCardGrid
        value={pick}
        onChoose={setPick}
        voices={voices}
        browserSupport={browserSupport}
        deviceClass={deviceClass}
        models={models}
        onBusy={label => step?.busy(label)}
      />
      <p className="fy-voice-step-line">{VOICE_STEP_LINE}</p>
      <details
        className="fy-voice-more"
        open={all}
        onToggle={event => setAll((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>{all ? 'Show fewer engines' : 'Show every engine'}</summary>
      </details>
      <StepDemo>
        <VoiceDemo pick={pick} />
      </StepDemo>
    </section>
  );
}
