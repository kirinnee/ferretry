/**
 * FIRST RUN › THIS DEVICE › "How should this device hear you?" — the engine cards, in a short list, with Off as a card too.
 *
 * A client step (`voice`, side client): it configures THIS browser (`fy:voice:stt-settings`), so it is asked once per device,
 * whichever daemon the person paired first. It shows at once (`ready()`); there is nothing to check first.
 *
 *   - Choosing a card saves the engine on this device and answers the step (`done()`). Off switches dictation off and keeps
 *     the engine, exactly as the Dictation switch in Settings › Voice does.
 *   - Choosing never downloads. A card's own Install button does, and while it runs the step is busy (`busy(label)`), so
 *     Next waits for it.
 *   - The list is short on purpose: this device's default first, then the fastest, a balanced one, the browser's own and
 *     Off. "Show every engine" opens the whole catalog, the same cards Settings › Voice draws.
 */

import { useMemo, useState } from 'react';
import type { SttSettings, SttSettingsPatch } from '../../lib/stt/stt-settings.ts';
import type { BrowserRecognitionSupport } from '../../lib/stt/browser-recognition.ts';
import { DEFAULT_ON_DEVICE_ENGINE, type DeviceClass } from '../../lib/stt/engine-defaults.ts';
import { ON_DEVICE_MODELS, type OnDeviceModel, type OnDeviceModelId } from '../../lib/stt/model-catalog.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import { Button } from '../../shell-voice.ts';
import { EngineCardGrid, type EngineChoice } from '../engine-card/engine-card-grid.tsx';
import type { StepHost } from '@ferretry/kernel/contract';
import { useStepReady } from './use-step-ready.ts';
import './voice-step.css';

export const VOICE_STEP_TITLE = 'How should this device hear you?';
const VOICE_STEP_LINE =
  'Pick an engine for dictation. Everything is chosen for this device only, and nothing downloads until you press Install.';

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
  const models = useMemo((): readonly OnDeviceModel[] => {
    if (all) return ON_DEVICE_MODELS;
    const wanted = shortListOf(deviceClass);
    return wanted.flatMap(id => ON_DEVICE_MODELS.filter(model => model.id === id));
  }, [all, deviceClass]);
  return (
    <section className="fy-voice-step" aria-labelledby="fy-voice-step-title">
      <h2 id="fy-voice-step-title" className="fy-voice-step-title">
        {VOICE_STEP_TITLE}
      </h2>
      <p className="fy-voice-step-line">{VOICE_STEP_LINE}</p>
      <EngineCardGrid
        value={choiceOf(settings)}
        onChoose={choice => {
          update(patchFor(choice));
          step?.done();
        }}
        voices={voices}
        browserSupport={browserSupport}
        deviceClass={deviceClass}
        models={models}
        onBusy={label => step?.busy(label)}
      />
      {all ? null : (
        <div>
          <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => setAll(true)}>
            Show every engine
          </Button>
        </div>
      )}
    </section>
  );
}
