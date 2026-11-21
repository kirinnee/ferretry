/**
 * THE ENGINE CARD GRID — every engine this device can dictate with as a row of short cards, in one radio group.
 *
 * It owns the wiring and none of the looks: which engines are listed, what each card says (`engine-numbers.ts`), the
 * install state of each on-device voice (`useOnDeviceInstall`), and which card the person just chose. The cards are
 * `engine-card.tsx`. Two callers use it: the first-run page (`app/features/onboarding/voice-step.tsx`, a short list) and
 * Settings › Voice (S5, the whole catalog), which is why the engines listed and the Off card are props.
 *
 * Nothing downloads until a person presses Install on a card, and choosing a card never installs it: an engine that is
 * chosen but not installed asks, in the dictation control, to be installed, as it always has.
 */

import { onRadioGroupKeyDown } from '@ferretry/app';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useOnDeviceInstall } from '../../hooks/use-on-device-install.ts';
import { cn } from '../../shell-voice.ts';
import type { BrowserRecognitionSupport } from '../../lib/stt/browser-recognition.ts';
import { DEFAULT_ON_DEVICE_ENGINE, type DeviceClass } from '../../lib/stt/engine-defaults.ts';
import { modelDownloadBytes, ON_DEVICE_MODELS, type OnDeviceModel } from '../../lib/stt/model-catalog.ts';
import { formatMegabytes } from '../../lib/stt/model-store.ts';
import type { OnDeviceInstallSnapshot, OnDeviceVoice } from '../../lib/stt/on-device-voice.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import type { DictationEngineId } from '../../lib/stt/stt-settings.ts';
import { EngineCard, type InstallView } from './engine-card.tsx';
import { ENGINE_BRIEF_LINES, ENGINE_LINES, engineBars } from './engine-numbers.ts';
import './engine-card.css';

/** What a card can choose: an engine, or `off` (dictation is switched off on this device). */
export type EngineChoice = DictationEngineId | 'off';

const FAMILY_LABELS: Readonly<Record<OnDeviceModel['family'], string>> = {
  parakeet: 'NVIDIA Parakeet',
  zipformer: 'k2 Zipformer',
  moonshine: 'Moonshine',
  whisper: 'OpenAI Whisper',
  vosk: 'Vosk',
};

/** The card's name: the short name, with the two Parakeets told apart. */
const cardName = (model: OnDeviceModel): string => (model.id === 'parakeet' ? 'Parakeet 0.6B' : model.shortName);

const languagesOf = (model: OnDeviceModel): string =>
  model.languages.length === 1
    ? model.languages[0] === 'en'
      ? 'English'
      : (model.languages[0] ?? '')
    : `${model.languages.length} languages`;

/** Chips: whether words appear while you speak, and that the audio stays on this device. */
export const chipsOf = (model: OnDeviceModel): readonly string[] => [
  ...(model.streaming ? ['Live words'] : model.nearLive ? ['Near-live'] : []),
  'On device',
];

/** The paragraphs behind the "i": the catalog's own sentence, the measured numbers, and who made it. */
const detailsOf = (model: OnDeviceModel): readonly string[] => [
  model.summary,
  ...(model.measured === undefined
    ? []
    : [
        `Measured (${model.measured.where}): ${[model.measured.speed, model.measured.accuracy].filter(part => part !== undefined).join('; ')}`,
      ]),
  `${FAMILY_LABELS[model.family]} · ${model.licence} · ${languagesOf(model)} · ${formatMegabytes(modelDownloadBytes(model))} to download once`,
];

const percentOf = (snapshot: OnDeviceInstallSnapshot): number =>
  snapshot.totalBytes > 0 ? Math.min(100, Math.floor((snapshot.downloadedBytes / snapshot.totalBytes) * 100)) : 0;

/** The install slot a snapshot draws. Pure, so the unit suite can walk every phase. */
export function installViewOf(snapshot: OnDeviceInstallSnapshot, voice: OnDeviceVoice): InstallView {
  const size = formatMegabytes(snapshot.totalBytes);
  switch (snapshot.phase) {
    case 'unsupported':
      return { kind: 'unavailable', reason: snapshot.reason ?? `This browser cannot run ${voice.model.shortName}.` };
    case 'checking':
    case 'removing':
      return { kind: 'checking' };
    case 'installed':
      return { kind: 'installed' };
    case 'installing':
      return { kind: 'installing', percent: percentOf(snapshot), size, onCancel: () => voice.cancel() };
    case 'partial':
      return {
        kind: 'partial',
        left: formatMegabytes(snapshot.totalBytes - snapshot.downloadedBytes),
        onInstall: () => void voice.install(),
      };
    case 'absent':
      return { kind: 'idle', size, onInstall: () => void voice.install() };
  }
}

interface OnDeviceCardProps {
  readonly model: OnDeviceModel;
  readonly voice: OnDeviceVoice | null;
  readonly badge: string | undefined;
  /** A few words under the name instead of the sentence (the first-run page). */
  readonly brief: boolean;
  readonly group: string;
  readonly value: EngineChoice | null;
  readonly chosen: EngineChoice | null;
  onChoose(choice: EngineChoice): void;
  onBusy(id: string, name: string, busy: boolean): void;
}

/** One on-device engine's card, over whatever install view and one-line the caller has for it. */
function OnDeviceFace({
  model,
  badge,
  brief,
  group,
  value,
  chosen,
  onChoose,
  install,
  line,
  error,
}: Omit<OnDeviceCardProps, 'voice' | 'onBusy'> & {
  readonly install: InstallView;
  readonly line: string;
  readonly error?: string;
}) {
  return (
    <EngineCard
      id={model.id}
      name={cardName(model)}
      line={line}
      bars={engineBars(model)}
      compact={brief}
      chips={chipsOf(model)}
      details={detailsOf(model)}
      selected={value === model.id}
      justChosen={chosen === model.id}
      group={group}
      onChoose={id => onChoose(id as EngineChoice)}
      install={install}
      {...(error === undefined ? {} : { error })}
      {...(badge === undefined ? {} : { badge })}
    />
  );
}

/** A card whose voice exists: its install phase is read live, and a running download is reported up. */
function InstallingCard({ voice, onBusy, brief, ...face }: OnDeviceCardProps & { readonly voice: OnDeviceVoice }) {
  const snapshot = useOnDeviceInstall(voice);
  const installing = snapshot.phase === 'installing';
  const { model } = face;
  useEffect(() => {
    onBusy(model.id, cardName(model), installing);
    return () => onBusy(model.id, cardName(model), false);
  }, [installing, model, onBusy]);
  return (
    <OnDeviceFace
      {...face}
      brief={brief}
      install={installViewOf(snapshot, voice)}
      line={
        installing
          ? `Downloading ${snapshot.label?.toLowerCase() ?? 'the model'}…`
          : (brief ? ENGINE_BRIEF_LINES : ENGINE_LINES)[model.id]
      }
      {...(snapshot.error === undefined ? {} : { error: snapshot.error.message })}
    />
  );
}

function OnDeviceCard({ voice, onBusy, brief, ...face }: OnDeviceCardProps) {
  if (voice !== null) return <InstallingCard voice={voice} onBusy={onBusy} brief={brief} {...face} />;
  return (
    <OnDeviceFace
      {...face}
      brief={brief}
      line={(brief ? ENGINE_BRIEF_LINES : ENGINE_LINES)[face.model.id]}
      install={{ kind: 'unavailable', reason: `${face.model.shortName} is not available in this copy of Ferretry.` }}
    />
  );
}

export interface EngineCardGridProps {
  /** The engine in use, `off` when dictation is off, or `null` before anyone has chosen. */
  readonly value: EngineChoice | null;
  onChoose(choice: EngineChoice): void;
  /** Every on-device voice; `null` outside a store, where each card says it is unavailable. */
  readonly voices: OnDeviceVoices | null;
  /** Parakeet 0.6B's voice when the caller holds it separately (suites); wins over `voices`. */
  readonly parakeet?: OnDeviceVoice | null;
  readonly browserSupport: BrowserRecognitionSupport;
  readonly deviceClass: DeviceClass;
  /** The on-device engines to list, in order. The whole catalog by default. */
  readonly models?: readonly OnDeviceModel[];
  /** Whether the browser's own voice is listed. */
  readonly browser?: boolean;
  /** Whether an Off card is listed. */
  readonly off?: boolean;
  /** A few words per card instead of a sentence (the first-run page; the full lines stay behind the "i"). */
  readonly brief?: boolean;
  /** Told when a download starts (`Downloading Whisper tiny…`) and when none is running (`null`). */
  onBusy?(label: string | null): void;
  readonly label?: string;
  readonly className?: string;
}

export function EngineCardGrid({
  value,
  onChoose,
  voices,
  parakeet,
  browserSupport,
  deviceClass,
  models = ON_DEVICE_MODELS,
  browser = true,
  off = true,
  brief = false,
  onBusy,
  label = 'How this device hears you',
  className,
}: EngineCardGridProps) {
  const group = useId();
  const [chosen, setChosen] = useState<EngineChoice | null>(null);
  const [running, setRunning] = useState<ReadonlyMap<string, string>>(new Map());
  const noteBusy = useMemo(
    () => (id: string, name: string, busy: boolean) =>
      setRunning(previous => {
        if (previous.has(id) === busy) return previous;
        const next = new Map(previous);
        if (busy) next.set(id, name);
        else next.delete(id);
        return next;
      }),
    [],
  );
  // Told only when the label CHANGES, so a grid with no download running never says "not busy" on its own.
  const told = useRef<string | null>(null);
  useEffect(() => {
    const first = [...running.values()][0];
    const label = first === undefined ? null : `Downloading ${first}…`;
    if (label === told.current) return;
    told.current = label;
    onBusy?.(label);
  }, [running, onBusy]);
  const choose = (choice: EngineChoice): void => {
    setChosen(choice);
    onChoose(choice);
  };
  // Four cards sit two by two, never three and one; the stylesheet reads the count.
  const count = models.length + (browser ? 1 : 0) + (off ? 1 : 0);
  const voiceFor = (model: OnDeviceModel): OnDeviceVoice | null =>
    model.id === 'parakeet' && parakeet !== undefined ? parakeet : (voices?.get(model.id) ?? null);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-count={count}
      onKeyDown={onRadioGroupKeyDown}
      className={cn('fy-engine-grid', className)}
    >
      {models.map(model => (
        <OnDeviceCard
          key={model.id}
          model={model}
          voice={voiceFor(model)}
          group={group}
          value={value}
          chosen={chosen}
          onChoose={choose}
          onBusy={noteBusy}
          badge={!brief && DEFAULT_ON_DEVICE_ENGINE[deviceClass] === model.id ? 'Default' : undefined}
          brief={brief}
        />
      ))}
      {browser ? (
        <EngineCard
          id="browser"
          name="Browser voice"
          line={brief ? '' : "Your browser's own. Words appear live."}
          bars={null}
          note={brief ? '' : 'Not measured. Nothing to download.'}
          chips={['Live words', 'Not on device']}
          details={[
            'The browser’s own speech recognition. Nothing downloads, but most browsers send the audio to their maker to be turned into text, so choose an on-device engine when that matters.',
            ...(browserSupport.available ? [] : [browserSupport.reason ?? 'This browser has no speech recognition.']),
          ]}
          selected={value === 'browser'}
          justChosen={chosen === 'browser'}
          group={group}
          onChoose={id => choose(id as EngineChoice)}
          install={
            browserSupport.available
              ? { kind: 'none' }
              : { kind: 'unavailable', reason: browserSupport.reason ?? 'This browser has no speech recognition.' }
          }
          disabled={!browserSupport.available}
        />
      ) : null}
      {off ? (
        <EngineCard
          id="off"
          name="Off"
          line={brief ? '' : 'No microphone button.'}
          bars={null}
          {...(brief ? { note: '' } : {})}
          chips={[]}
          details={['Dictation is switched off on this device. Turn it on again any time in Settings › Voice.']}
          selected={value === 'off'}
          justChosen={chosen === 'off'}
          group={group}
          onChoose={id => choose(id as EngineChoice)}
          install={{ kind: 'none' }}
        />
      ) : null}
    </div>
  );
}
