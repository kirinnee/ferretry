/**
 * EVERY WAY THIS DEVICE CAN TURN SPEECH INTO TEXT — Settings › Voice › Engine.
 *
 * One row per engine: each on-device model in the catalog (`lib/stt/model-catalog.ts`) and the
 * phone's/browser's own recognition. A row says what the engine costs before anything happens — its
 * download size, licence, languages, whether words appear while you speak — and holds the three things
 * a person does with it:
 *
 *   - INSTALL / REMOVE. Nothing downloads until Install is pressed; a download can be cancelled and
 *     resumed, and Remove frees the space.
 *   - USE THIS. The radio that makes it the engine the microphone dictates with on this device.
 *   - TRY IT. Records five seconds and shows the text with how long each part took, so engines can be
 *     compared side by side without changing which one dictation uses.
 *
 * None is a fallback for another and nothing is chosen for the person. "Audio never leaves this
 * device" is said for an on-device engine only; the browser row says where its audio goes.
 *
 * NO AUTOFOCUS, per this app's touch rules, and every target is at least 44 px.
 */

import { Check, CircleSlash2, Download, FlaskConical, Mic, Radio, ShieldCheck, Trash2, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useOnDeviceInstall } from '../../hooks/use-on-device-install.ts';
import { cn } from '../../lib/class-names.ts';
import {
  type BrowserRecognitionProvider,
  BrowserRecognitionSession,
  type BrowserRecognitionSupport,
} from '../../lib/stt/browser-recognition.ts';
import {
  type EngineTrial,
  type EngineTrialPorts,
  type EngineTrialResult,
  type EngineTrialUpdate,
  formatSeconds,
  startEngineTrial,
  TRIAL_RECORD_MS,
} from '../../lib/stt/engine-trial.ts';
import {
  modelDownloadBytes,
  ON_DEVICE_MODELS,
  type OnDeviceModel,
  type SpeechModelFamily,
} from '../../lib/stt/model-catalog.ts';
import { formatMegabytes } from '../../lib/stt/model-store.ts';
import type {
  OnDeviceInstallSnapshot,
  OnDeviceSession,
  OnDeviceSessionOptions,
  OnDeviceVoice,
} from '../../lib/stt/on-device-voice.ts';
import type { OnDeviceVoices } from '../../lib/stt/on-device-voices.ts';
import { type DictationEngineId, isOnDeviceEngine } from '../../lib/stt/stt-settings.ts';
import { Button } from '../../shell/primitives.tsx';
import {
  BROWSER_ACTIVE_NOTE,
  BROWSER_ENGINE_DISCLOSURE,
  BROWSER_ENGINE_LABEL,
  BROWSER_ENGINE_SUMMARY,
  NO_ENGINE_NOTE,
} from './voice-engine-choice.tsx';

const ENGINE_LIST_INTRO =
  'Install as many as you like and try each one. The one in use is what the microphone dictates with on this device.';
export const LIVE_WORDS_BADGE = 'Live words';
export const NEAR_LIVE_BADGE = 'Near-live words';
export const ON_DEVICE_BADGE = 'On this device';
export const INSTALL_FOOTNOTE =
  'Downloaded once from Hugging Face, checked byte for byte, and kept in this browser. Browsers can clear site data they need room for; if that happens, install it again here.';
const TRIAL_EXPLANATION = `Try it records ${TRIAL_RECORD_MS / 1000} seconds and shows what it heard and how long it took. It changes nothing: not your draft, not the engine in use.`;

const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: 'English' };

/** Who made the model, as a person would recognise it. */
const FAMILY_LABELS: Readonly<Record<SpeechModelFamily, string>> = {
  parakeet: 'NVIDIA Parakeet',
  zipformer: 'k2 Zipformer',
  moonshine: 'Moonshine',
  whisper: 'OpenAI Whisper',
  vosk: 'Vosk',
};

/** "English", or "10 languages" for a multilingual model. */
const languagesOf = (model: OnDeviceModel): string =>
  model.languages.length === 1
    ? (LANGUAGE_NAMES[model.languages[0] ?? ''] ?? model.languages[0] ?? '')
    : `${model.languages.length} languages`;

/** The active-engine sentence. The on-device one is the only place the promise is made. */
export const activeEngineNote = (engine: DictationEngineId | null): string => {
  if (engine === null) return NO_ENGINE_NOTE;
  if (engine === 'browser') return BROWSER_ACTIVE_NOTE;
  const model = ON_DEVICE_MODELS.find(entry => entry.id === engine);
  return `${model?.shortName ?? 'This engine'} is active: audio never leaves this device.`;
};

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const percent = (snapshot: OnDeviceInstallSnapshot): number =>
  snapshot.totalBytes > 0 ? Math.min(100, Math.floor((snapshot.downloadedBytes / snapshot.totalBytes) * 100)) : 0;

/** The clock a trial runs on. Tests pass their own; production uses the page's. */
export type TrialClock = Pick<EngineTrialPorts, 'now' | 'setTimeout' | 'clearTimeout' | 'recordMs'>;

const pageClock: TrialClock = {
  now: () => globalThis.performance?.now() ?? Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function Badge({ children, tone }: { readonly children: string; readonly tone: 'accent' | 'ok' | 'muted' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-meta leading-none',
        tone === 'accent' && 'border-accent text-accent',
        tone === 'ok' && 'border-ok text-ok',
        tone === 'muted' && 'border-border text-muted',
      )}
    >
      {children}
    </span>
  );
}

/** One model's install: its size before anything downloads, progress with Cancel, Resume, and Remove. */
function ModelInstallControls({ voice }: { readonly voice: OnDeviceVoice }) {
  const snapshot = useOnDeviceInstall(voice);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const progressId = useId();
  const size = formatMegabytes(snapshot.totalBytes);
  const name = voice.model.shortName;

  if (snapshot.phase === 'unsupported')
    return (
      <p className="m-0 flex items-start gap-1 text-meta leading-base text-warn" role="status">
        <CircleSlash2 size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{snapshot.reason}</span>
      </p>
    );

  if (snapshot.phase === 'installed')
    return (
      <div className="flex flex-col gap-2" data-model-phase="installed">
        <p className="m-0 flex items-start gap-1 text-meta leading-base text-ok" role="status">
          <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            Installed · {size}
            {snapshot.installedAt === undefined ? '' : ` · ${formatDate(snapshot.installedAt)}`}
          </span>
        </p>
        {snapshot.version === undefined ? null : (
          <p className="m-0 min-w-0 break-words text-meta leading-base text-faint">{snapshot.version}</p>
        )}
        {confirmingRemove ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-meta text-fg">Remove {size} from this device?</span>
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="min-h-[44px]"
              onClick={() => {
                setConfirmingRemove(false);
                void voice.remove();
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              <span className="ml-1">Remove</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-[44px]"
              onClick={() => setConfirmingRemove(false)}
            >
              Keep it
            </Button>
          </div>
        ) : (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-[44px]"
              onClick={() => setConfirmingRemove(true)}
            >
              <Trash2 size={14} aria-hidden="true" />
              <span className="ml-1">Remove {name}</span>
            </Button>
          </div>
        )}
      </div>
    );

  if (snapshot.phase === 'installing')
    return (
      <div className="flex flex-col gap-2" data-model-phase="installing">
        <div className="flex items-baseline justify-between gap-2 text-meta">
          <span id={progressId} className="text-fg">
            Downloading{snapshot.label === undefined ? '' : ` ${snapshot.label.toLowerCase()}`}…
          </span>
          <span className="mono tabular-nums text-muted">
            {formatMegabytes(snapshot.downloadedBytes)} of {size}
          </span>
        </div>
        <div
          role="progressbar"
          aria-labelledby={progressId}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent(snapshot)}
          aria-valuetext={`${percent(snapshot)}% — ${formatMegabytes(snapshot.downloadedBytes)} of ${size}`}
          className="h-2 w-full overflow-hidden rounded-full bg-surface"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent(snapshot)}%` }} />
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => voice.cancel()}>
            <X size={14} aria-hidden="true" />
            <span className="ml-1">Cancel</span>
          </Button>
        </div>
      </div>
    );

  const partial = snapshot.phase === 'partial';
  const busy = snapshot.phase === 'checking' || snapshot.phase === 'removing';
  return (
    <div className="flex flex-col gap-2" data-model-phase={snapshot.phase}>
      {partial ? (
        <p className="m-0 text-meta leading-base text-fg">
          {formatMegabytes(snapshot.downloadedBytes)} of {size} downloaded. Resume carries on where it stopped.
        </p>
      ) : null}
      {snapshot.error === undefined ? null : (
        <p className="m-0 text-meta leading-base text-warn" role="alert">
          {snapshot.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="min-h-[44px]"
          disabled={busy}
          onClick={() => void voice.install()}
        >
          <Download size={14} aria-hidden="true" />
          <span className="ml-1">
            {busy
              ? snapshot.phase === 'removing'
                ? 'Removing…'
                : 'Checking this device…'
              : partial
                ? `Resume (${formatMegabytes(snapshot.totalBytes - snapshot.downloadedBytes)} left)`
                : `Install ${name} (${size})`}
          </span>
        </Button>
        {partial ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-[44px]" onClick={() => void voice.remove()}>
            Discard partial download
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type TrialState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly update: EngineTrialUpdate }
  | { readonly kind: 'done'; readonly result: EngineTrialResult }
  | { readonly kind: 'failed'; readonly message: string };

const TRIAL_PHASE_COPY: Readonly<Record<EngineTrialUpdate['phase'], string>> = {
  opening: 'Opening the microphone…',
  recording: `Recording ${TRIAL_RECORD_MS / 1000} s — say a sentence.`,
  transcribing: 'Transcribing…',
};

/** Records a short take with one engine and shows the words and the timings. */
function EngineTrialControl({
  name,
  open,
  clock,
}: {
  readonly name: string;
  open(options: OnDeviceSessionOptions): OnDeviceSession;
  readonly clock: TrialClock;
}) {
  const [state, setState] = useState<TrialState>({ kind: 'idle' });
  const trialRef = useRef<EngineTrial | null>(null);
  useEffect(() => () => trialRef.current?.cancel(), []);

  const start = (): void => {
    trialRef.current?.cancel();
    // Updates can arrive while the trial is still being started, before it has a name to compare.
    const owner = { trial: null as EngineTrial | null };
    const trial = startEngineTrial({ ...clock, open }, update => {
      if (owner.trial === null || trialRef.current === owner.trial) setState({ kind: 'running', update });
    });
    owner.trial = trial;
    trialRef.current = trial;
    trial.result.then(
      result => {
        if (trialRef.current !== trial) return;
        trialRef.current = null;
        setState({ kind: 'done', result });
      },
      (error: unknown) => {
        if (trialRef.current !== trial) return;
        trialRef.current = null;
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'aborted') setState({ kind: 'idle' });
        else setState({ kind: 'failed', message: error instanceof Error ? error.message : 'The trial failed.' });
      },
    );
  };

  if (state.kind === 'running')
    return (
      <div className="flex flex-col gap-2 rounded-control border border-border bg-surface p-2" data-trial="running">
        <p className="m-0 flex items-center gap-1 text-meta text-fg" role="status">
          <Mic size={14} aria-hidden="true" className="shrink-0 text-accent" />
          <span>{TRIAL_PHASE_COPY[state.update.phase]}</span>
        </p>
        {state.update.live === '' ? null : <p className="m-0 text-meta leading-base text-muted">{state.update.live}</p>}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={() => trialRef.current?.cancel()}
          >
            <X size={14} aria-hidden="true" />
            <span className="ml-1">Stop trial</span>
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      {state.kind === 'done' ? (
        <div className="flex flex-col gap-1 rounded-control border border-border bg-surface p-2" data-trial="done">
          <p className="m-0 text-ui leading-base text-fg">
            {state.result.text === '' ? <span className="text-faint">(nothing heard)</span> : `“${state.result.text}”`}
          </p>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-meta leading-base">
            <dt className="text-muted">Microphone open</dt>
            <dd className="m-0 mono tabular-nums text-fg">{formatSeconds(state.result.openMs)}</dd>
            <dt className="text-muted">First words</dt>
            <dd className="m-0 mono tabular-nums text-fg">
              {state.result.firstWordMs === null ? 'after Stop' : `${formatSeconds(state.result.firstWordMs)} in`}
            </dd>
            <dt className="text-muted">Text after Stop</dt>
            <dd className="m-0 mono tabular-nums text-fg">{formatSeconds(state.result.finishMs)}</dd>
            {state.result.loadMs === null ? null : (
              <>
                <dt className="text-muted">Model load (first take only)</dt>
                <dd className="m-0 mono tabular-nums text-fg">{formatSeconds(state.result.loadMs)}</dd>
              </>
            )}
            {state.result.model === undefined ? null : (
              <>
                <dt className="text-muted">Ran on</dt>
                <dd className="m-0 min-w-0 break-words text-fg">{state.result.model}</dd>
              </>
            )}
          </dl>
        </div>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="m-0 text-meta leading-base text-warn" role="alert">
          {state.message}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-[44px]"
          onClick={start}
          aria-label={`Try ${name}`}
        >
          <FlaskConical size={14} aria-hidden="true" />
          <span className="ml-1">{state.kind === 'idle' ? `Try it (${TRIAL_RECORD_MS / 1000} s)` : 'Try again'}</span>
        </Button>
      </div>
    </div>
  );
}

interface RowFrameProps {
  readonly id: DictationEngineId;
  readonly name: string;
  readonly label: string;
  readonly selected: boolean;
  readonly group: string;
  onChoose(engine: DictationEngineId): void;
  readonly children: ReactNode;
}

/** A row's frame: the name, the "Use this" radio, and whatever the row holds. */
function RowFrame({ id, name, label, selected, group, onChoose, children }: RowFrameProps) {
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-control border p-3',
        selected ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2',
      )}
      data-engine={id}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <span className={cn('min-w-0 break-words text-ui font-semibold', selected ? 'text-accent' : 'text-fg')}>
          {label}
        </span>
        <label className="flex min-h-[44px] shrink-0 cursor-pointer items-center gap-2 text-meta">
          <input
            type="radio"
            name={group}
            value={id}
            checked={selected}
            onChange={() => onChoose(id)}
            aria-label={`Use ${name}`}
          />
          <span className={selected ? 'font-semibold text-accent' : 'text-fg'}>{selected ? 'In use' : 'Use this'}</span>
        </label>
      </div>
      {children}
    </li>
  );
}

function ModelRow({
  model,
  voice,
  selected,
  group,
  onChoose,
  clock,
}: {
  readonly model: OnDeviceModel;
  readonly voice: OnDeviceVoice | null;
  readonly selected: boolean;
  readonly group: string;
  onChoose(engine: DictationEngineId): void;
  readonly clock: TrialClock;
}) {
  const facts = [
    FAMILY_LABELS[model.family],
    formatMegabytes(modelDownloadBytes(model)),
    model.licence,
    languagesOf(model),
  ];
  return (
    <RowFrame
      id={model.id}
      name={model.shortName}
      label={model.label}
      selected={selected}
      group={group}
      onChoose={onChoose}
    >
      <div className="flex flex-wrap gap-1">
        <Badge tone="ok">{ON_DEVICE_BADGE}</Badge>
        {model.streaming ? <Badge tone="accent">{LIVE_WORDS_BADGE}</Badge> : null}
        {!model.streaming && model.nearLive ? <Badge tone="muted">{NEAR_LIVE_BADGE}</Badge> : null}
      </div>
      <p className="m-0 text-meta leading-base text-muted">{facts.join(' · ')}</p>
      <p className="m-0 text-meta leading-base text-fg">{model.summary}</p>
      {model.measured === undefined ? null : (
        <p className="m-0 text-meta leading-base text-faint">
          Measured ({model.measured.where}):{' '}
          {[model.measured.speed, model.measured.accuracy].filter(part => part !== undefined).join('; ')}
        </p>
      )}
      {voice === null ? (
        <p className="m-0 flex items-start gap-1 text-meta leading-base text-warn" role="status">
          <CircleSlash2 size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{model.shortName} is not available in this copy of Ferretry.</span>
        </p>
      ) : (
        <ModelVoiceControls voice={voice} clock={clock} />
      )}
    </RowFrame>
  );
}

function ModelVoiceControls({ voice, clock }: { readonly voice: OnDeviceVoice; readonly clock: TrialClock }) {
  const snapshot = useOnDeviceInstall(voice);
  return (
    <>
      <ModelInstallControls voice={voice} />
      {snapshot.phase === 'installed' ? (
        <EngineTrialControl name={voice.model.shortName} open={options => voice.createSession(options)} clock={clock} />
      ) : null}
    </>
  );
}

export interface EngineCatalogListProps {
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
  readonly className?: string;
}

export function EngineCatalogList({
  value,
  onChange,
  voices,
  parakeet,
  browserSupport,
  browserProvider,
  clock = pageClock,
  models = ON_DEVICE_MODELS,
  className,
}: EngineCatalogListProps) {
  const group = useId();
  const voiceFor = (model: OnDeviceModel): OnDeviceVoice | null =>
    model.id === 'parakeet' && parakeet !== undefined ? parakeet : (voices?.get(model.id) ?? null);
  const onDevice = isOnDeviceEngine(value);
  return (
    <fieldset className={cn('m-0 flex min-w-0 flex-col gap-2 border-0 p-0', className)}>
      <legend className="mb-1 p-0 text-ui font-semibold">How this device turns speech into text</legend>
      <p className="m-0 text-meta leading-base text-muted">{ENGINE_LIST_INTRO}</p>
      <p className="m-0 text-meta leading-base text-faint">{TRIAL_EXPLANATION}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {models.map(model => (
          <ModelRow
            key={model.id}
            model={model}
            voice={voiceFor(model)}
            selected={value === model.id}
            group={group}
            onChoose={onChange}
            clock={clock}
          />
        ))}
        <RowFrame
          id="browser"
          name={BROWSER_ENGINE_LABEL}
          label={`${BROWSER_ENGINE_LABEL} (${BROWSER_ENGINE_DISCLOSURE})`}
          selected={value === 'browser'}
          group={group}
          onChoose={onChange}
        >
          <div className="flex flex-wrap gap-1">
            <Badge tone="accent">{LIVE_WORDS_BADGE}</Badge>
            <Badge tone="muted">No download</Badge>
          </div>
          <p className="m-0 text-meta leading-base text-fg">{BROWSER_ENGINE_SUMMARY}</p>
          {browserSupport.available ? (
            <EngineTrialControl
              name={BROWSER_ENGINE_LABEL}
              open={options => new BrowserRecognitionSession(browserProvider, options)}
              clock={clock}
            />
          ) : (
            <p className="m-0 flex items-start gap-1 text-meta leading-base text-warn">
              <CircleSlash2 size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{browserSupport.reason}</span>
            </p>
          )}
        </RowFrame>
      </ul>
      <p className="m-0 text-meta leading-base text-faint">{INSTALL_FOOTNOTE}</p>
      <p
        className={cn(
          'm-0 flex items-start gap-1 text-meta leading-base',
          onDevice ? 'text-ok' : value === 'browser' ? 'text-warn' : 'text-muted',
        )}
        role="status"
      >
        {onDevice ? <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : null}
        {value === 'browser' ? <Radio size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : null}
        <span>{activeEngineNote(value)}</span>
      </p>
    </fieldset>
  );
}
