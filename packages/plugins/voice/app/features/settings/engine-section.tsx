/**
 * HOW THIS DEVICE HEARS YOU — Settings › Voice › Engine (r10 S5).
 *
 * The whole engine list is O15's short fixed-height cards (`engine-card/`), so ten engines read as a grid, not ten
 * 470 px boxes: a name, one line, three bars (speed / accuracy / size) and an Install button. What the old list also did
 * stays, one row each under the cards instead of inside every one of them:
 *   - TRY IT: records a few seconds with the chosen engine and shows what it heard (`engine-trial-control.tsx`);
 *   - REMOVE: a model downloaded earlier is listed with its size and a Remove button, to free the space;
 *   - what the chosen engine means for the audio ("Audio never leaves this device" is said for an on-device one only).
 *
 * Laid out by the settings panel's width (`voice-settings.css`), never the viewport.
 */

import { Radio, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useOnDeviceInstall } from '../../hooks/use-on-device-install.ts';
import { Button, cn, SettingGroup, SettingRow } from '../../shell-voice.ts';
import { type BrowserRecognitionProvider, BrowserRecognitionSession } from '../../lib/stt/browser-recognition.ts';
import type { BrowserRecognitionSupport } from '../../lib/stt/browser-recognition.ts';
import { DEFAULT_ON_DEVICE_ENGINE, type DeviceClass } from '../../lib/stt/engine-defaults.ts';
import { ON_DEVICE_MODELS, type OnDeviceModel } from '../../lib/stt/model-catalog.ts';
import { formatMegabytes } from '../../lib/stt/model-store.ts';
import type { OnDeviceVoice } from '../../lib/stt/on-device-voice.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import { type DictationEngineId, isOnDeviceEngine } from '../../lib/stt/stt-settings.ts';
import { EngineCardGrid } from '../engine-card/engine-card-grid.tsx';
import { shortListOf } from '../onboarding/voice-step.tsx';
import { EngineTrialControl, pageClock, TRIAL_EXPLANATION, type TrialClock } from './engine-trial-control.tsx';
import { BROWSER_ACTIVE_NOTE, BROWSER_ENGINE_LABEL, NO_ENGINE_NOTE } from './voice-engine-choice.tsx';

export type { TrialClock } from './engine-trial-control.tsx';

const ENGINE_LIST_INTRO =
  'Install as many as you like and try each one. The one in use is what the microphone dictates with on this device.';
const INSTALL_FOOTNOTE =
  'Downloaded once from Hugging Face, checked byte for byte, and kept in this browser. Browsers can clear site data they need room for; if that happens, install it again here.';

/** What a device dictates with until it chooses, when it has a default. */
export const defaultEngineNote = (device: DeviceClass): string => {
  const model = ON_DEVICE_MODELS.find(entry => entry.id === DEFAULT_ON_DEVICE_ENGINE[device]);
  return `Nothing chosen yet, so this ${device} dictates with ${model?.shortName ?? 'its default'}, after you install it. Choose another any time.`;
};

/** The active-engine sentence. The on-device one is the only place the promise is made. */
export const activeEngineNote = (engine: DictationEngineId | null, device?: DeviceClass): string => {
  if (engine === null) return device === undefined ? NO_ENGINE_NOTE : defaultEngineNote(device);
  if (engine === 'browser') return BROWSER_ACTIVE_NOTE;
  const model = ON_DEVICE_MODELS.find(entry => entry.id === engine);
  return `${model?.shortName ?? 'This engine'} is active: audio never leaves this device.`;
};

/** A downloaded (or half-downloaded) model, with the one button that frees its space. Draws nothing for any other. */
function DownloadedModel({ voice }: { readonly voice: OnDeviceVoice }) {
  const snapshot = useOnDeviceInstall(voice);
  if (snapshot.phase !== 'installed' && snapshot.phase !== 'partial') return null;
  const partial = snapshot.phase === 'partial';
  const name = voice.model.shortName;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-downloaded={voice.model.id}>
      <span className="min-w-0 flex-1 basis-40 text-ui text-fg">
        {name}
        <span className="text-meta text-muted">
          {partial ? ' · partly downloaded' : ` · ${formatMegabytes(snapshot.totalBytes)}`}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-[44px]"
        aria-label={`${partial ? 'Discard the partial download of' : 'Remove'} ${name} from this device`}
        onClick={() => void voice.remove()}
      >
        {partial ? 'Discard' : 'Remove'}
      </Button>
    </li>
  );
}

/** Try it for whichever on-device model is chosen, once it is installed. */
function TryOnDevice({ voice, clock }: { readonly voice: OnDeviceVoice; readonly clock: TrialClock }) {
  const snapshot = useOnDeviceInstall(voice);
  if (snapshot.phase !== 'installed')
    return <span className="fy-vs-note">{`Install ${voice.model.shortName} to try it.`}</span>;
  return (
    <EngineTrialControl name={voice.model.shortName} open={options => voice.createSession(options)} clock={clock} />
  );
}

export interface EngineSectionProps {
  /** The chosen engine, or `null` before anyone has chosen. */
  readonly value: DictationEngineId | null;
  onChange(engine: DictationEngineId): void;
  /** Every on-device voice; `null` outside a store, where each model says it is unavailable. */
  readonly voices: OnDeviceVoices | null;
  /** Parakeet's voice when the caller holds it separately (suites, onboarding); wins over `voices`. */
  readonly parakeet?: OnDeviceVoice | null;
  /** Whether the browser engine works on this page; production reads the page. */
  readonly browserSupport: BrowserRecognitionSupport;
  /** The browser engine, for its Try it. */
  readonly browserProvider: BrowserRecognitionProvider;
  /** Injected by suites; the page's clock otherwise. */
  readonly clock?: TrialClock;
  /** The models to list. The catalog by default; suites list their own. */
  readonly models?: readonly OnDeviceModel[];
  /** Phone or computer: marks the engine this device dictates with until it chooses one. */
  readonly deviceClass: DeviceClass;
}

export function EngineSection({
  value,
  onChange,
  voices,
  parakeet,
  browserSupport,
  browserProvider,
  clock = pageClock,
  models = ON_DEVICE_MODELS,
  deviceClass,
}: EngineSectionProps) {
  const voiceFor = (model: OnDeviceModel): OnDeviceVoice | null =>
    model.id === 'parakeet' && parakeet !== undefined ? parakeet : (voices?.get(model.id) ?? null);
  const onDevice = isOnDeviceEngine(value);
  // The engine Try it uses, and the card shown as selected: the chosen one, or the one this device dictates with until it
  // chooses (Parakeet 110M). Nothing is written until a card is pressed.
  const trialEngine = value ?? DEFAULT_ON_DEVICE_ENGINE[deviceClass];
  const trialModel = models.find(model => model.id === trialEngine);
  const trialVoice = trialModel === undefined ? null : voiceFor(trialModel);
  // The list is short on purpose (the owner: "voice options TOO much"): this device's default, the fastest and a balanced one, and
  // whatever is chosen. "Show every engine" opens the rest; a chosen engine is never hidden.
  const [all, setAll] = useState(false);
  const wanted = new Set<string>([...shortListOf(deviceClass), ...(value === null ? [] : [value])]);
  const shown = all ? models : models.filter(model => wanted.has(model.id));
  const hidden = models.length - shown.length;
  const shortCount = models.filter(model => wanted.has(model.id)).length;
  return (
    <SettingGroup label="Engine">
      <SettingRow
        name="How this device hears you"
        hint="Pick one; install it from its tile"
        explanation={`${ENGINE_LIST_INTRO} ${INSTALL_FOOTNOTE}`}
      >
        <div className="fy-vs-body fy-vs-engines" data-engine-section="">
          <EngineCardGrid
            value={trialEngine}
            onChoose={choice => {
              if (choice !== 'off') onChange(choice);
            }}
            voices={voices}
            {...(parakeet === undefined ? {} : { parakeet })}
            browserSupport={browserSupport}
            deviceClass={deviceClass}
            models={shown}
            off={false}
          />
          {hidden > 0 ? (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-[44px]"
                data-engine-show-all=""
                onClick={() => setAll(true)}
              >
                {`Show every engine (${hidden} more)`}
              </Button>
            </div>
          ) : all && models.length > shortCount ? (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-[44px]"
                data-engine-show-fewer=""
                onClick={() => setAll(false)}
              >
                Show fewer engines
              </Button>
            </div>
          ) : null}
          <p
            className={cn('fy-vs-note', value === null && 'text-muted')}
            data-tone={onDevice ? 'ok' : value === 'browser' ? 'warn' : undefined}
            role="status"
          >
            {onDevice ? <ShieldCheck size={14} aria-hidden="true" className="mr-1 inline align-text-bottom" /> : null}
            {value === 'browser' ? (
              <Radio size={14} aria-hidden="true" className="mr-1 inline align-text-bottom" />
            ) : null}
            {activeEngineNote(value, deviceClass)}
          </p>
        </div>
      </SettingRow>
      <SettingRow
        name="Try it"
        hint="Say a sentence and see what it hears"
        explanation={TRIAL_EXPLANATION}
        wide
        control={() =>
          trialEngine === 'browser' ? (
            browserSupport.available ? (
              <EngineTrialControl
                name={BROWSER_ENGINE_LABEL}
                open={options => new BrowserRecognitionSession(browserProvider, options)}
                clock={clock}
              />
            ) : (
              <span className="fy-vs-note" data-tone="warn">
                {browserSupport.reason}
              </span>
            )
          ) : trialVoice === null ? (
            <span className="fy-vs-note">Install an engine to try it.</span>
          ) : (
            <TryOnDevice voice={trialVoice} clock={clock} />
          )
        }
      />
      <SettingRow
        name="Downloaded engines"
        hint="Remove one to free its space"
        wide
        explanation="Each engine is kept in this browser. Removing one deletes its download; you can install it again from its tile."
      >
        <ul className="fy-vs-body fy-vs-downloads m-0 list-none" aria-label="Downloaded engines">
          {models.map(model => {
            const voice = voiceFor(model);
            return voice === null ? null : <DownloadedModel key={model.id} voice={voice} />;
          })}
        </ul>
      </SettingRow>
    </SettingGroup>
  );
}
