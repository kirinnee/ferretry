/**
 * HOW THIS DEVICE TURNS SPEECH INTO TEXT — the choice, and Parakeet's install.
 *
 * Two first-class engines, side by side, each with what it costs said up front:
 *
 *   - PARAKEET ON THIS DEVICE: a one-time download (its size is on the button), then it runs in this
 *     browser and works offline. The install lives here — progress, Cancel, Resume, Remove — because
 *     choosing Parakeet without installing it would choose a microphone that cannot work.
 *   - PHONE/BROWSER VOICE: the phone's or browser's own recognition. Nothing to download, and the
 *     label says plainly where the audio goes: to the browser vendor's servers.
 *
 * Neither is a fallback for the other, and nothing is picked for the person: an unchosen device asks.
 *
 * REUSABLE. Settings › Voice renders {@link VoiceEngineChoice}; onboarding renders the same component
 * as a step, and {@link ParakeetInstallStep} alone wherever only the download is wanted. Both take the
 * voice service and the value as props, so the caller decides where the choice is stored.
 *
 * "Audio never leaves this device" appears ONLY while Parakeet is the active engine — anywhere else it
 * would be a promise the active engine does not keep.
 */

import { Check, CircleSlash2, Download, ShieldCheck, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useParakeetInstall } from '../../hooks/use-parakeet-install.ts';
import { cn } from '../../lib/class-names.ts';
import type { BrowserRecognitionSupport } from '../../lib/stt/browser-recognition.ts';
import { formatMegabytes } from '../../lib/stt/parakeet-model.ts';
import type { ParakeetInstallSnapshot, ParakeetVoice } from '../../lib/stt/parakeet-voice.ts';
import type { DictationEngineId } from '../../lib/stt/stt-settings.ts';
import { Button } from '../../shell/primitives.tsx';

export const PARAKEET_ENGINE_LABEL = 'Parakeet on this device';
export const BROWSER_ENGINE_LABEL = 'Phone/browser voice';
/** The honest half of the browser engine's name, shown with it everywhere it is offered. */
export const BROWSER_ENGINE_DISCLOSURE = 'sent to your browser vendor’s servers';

export const PARAKEET_ENGINE_SUMMARY =
  'Private and works offline: the Parakeet speech model runs inside this browser. Download it once to this device.';
export const BROWSER_ENGINE_SUMMARY =
  'Nothing to download: your phone’s or browser’s own speech recognition. Chrome, Android and Safari send the audio to Google or Apple to turn it into text, so it needs a connection and their privacy policy applies.';

/** The active-engine sentences. The first is the only place the promise is made. */
export const PARAKEET_ACTIVE_NOTE = 'Parakeet is active: audio never leaves this device.';
export const BROWSER_ACTIVE_NOTE =
  'Phone/browser voice is active: your browser sends what you say to its vendor’s servers to transcribe it.';
export const NO_ENGINE_NOTE =
  'Choose one to turn dictation on. You can switch at any time; each device keeps its own choice.';

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const percent = (snapshot: ParakeetInstallSnapshot): number =>
  snapshot.totalBytes > 0 ? Math.min(100, Math.floor((snapshot.downloadedBytes / snapshot.totalBytes) * 100)) : 0;

export interface ParakeetInstallStepProps {
  readonly voice: ParakeetVoice | null;
  readonly className?: string;
}

/**
 * Parakeet's install on this device: its size before anything downloads, progress with Cancel while
 * it does, Resume after an interruption, and the installed version with Remove.
 */
export function ParakeetInstallStep({ voice, className }: ParakeetInstallStepProps) {
  const snapshot = useParakeetInstall(voice);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const progressId = useId();
  const size = formatMegabytes(snapshot.totalBytes);

  if (snapshot.phase === 'unsupported')
    return (
      <p className={cn('m-0 flex items-start gap-1 text-meta leading-base text-warn', className)} role="status">
        <CircleSlash2 size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{snapshot.reason}</span>
      </p>
    );

  if (snapshot.phase === 'installed')
    return (
      <div className={cn('flex flex-col gap-2', className)} data-parakeet-phase="installed">
        <p className="m-0 flex items-start gap-1 text-meta leading-base text-ok" role="status">
          <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>Installed on this device.</span>
        </p>
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta leading-base">
          <dt className="text-muted">Version</dt>
          <dd className="m-0 min-w-0 break-words text-fg">{snapshot.version}</dd>
          <dt className="text-muted">Size</dt>
          <dd className="m-0 text-fg">{size}</dd>
          {snapshot.installedAt === undefined ? null : (
            <>
              <dt className="text-muted">Installed</dt>
              <dd className="m-0 text-fg">{formatDate(snapshot.installedAt)}</dd>
            </>
          )}
        </dl>
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
                void voice?.remove();
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
              <span className="ml-1">Remove from this device</span>
            </Button>
          </div>
        )}
      </div>
    );

  if (snapshot.phase === 'installing')
    return (
      <div className={cn('flex flex-col gap-2', className)} data-parakeet-phase="installing">
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
          className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent(snapshot)}%` }} />
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => voice?.cancel()}>
            <X size={14} aria-hidden="true" />
            <span className="ml-1">Cancel</span>
          </Button>
        </div>
        <p className="m-0 text-meta leading-base text-faint">
          Cancelling keeps what has downloaded, so you can resume later. Keep this page open until it finishes.
        </p>
      </div>
    );

  const partial = snapshot.phase === 'partial';
  const busy = snapshot.phase === 'checking' || snapshot.phase === 'removing';
  return (
    <div className={cn('flex flex-col gap-2', className)} data-parakeet-phase={snapshot.phase}>
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
          onClick={() => void voice?.install()}
        >
          <Download size={14} aria-hidden="true" />
          <span className="ml-1">
            {busy
              ? snapshot.phase === 'removing'
                ? 'Removing…'
                : 'Checking this device…'
              : partial
                ? `Resume download (${formatMegabytes(snapshot.totalBytes - snapshot.downloadedBytes)} left)`
                : `Install Parakeet (about ${size})`}
          </span>
        </Button>
        {partial ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-[44px]" onClick={() => void voice?.remove()}>
            Discard partial download
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-meta leading-base text-faint">
        Downloaded once from Hugging Face, checked byte for byte, and kept in this browser. It needs about 1 GB of
        memory while it transcribes. Browsers can clear site data they need room for; if that happens, install it again
        here.
      </p>
    </div>
  );
}

export interface VoiceEngineChoiceProps {
  /** The chosen engine, or `null` before anyone has chosen. */
  readonly value: DictationEngineId | null;
  onChange(engine: DictationEngineId): void;
  readonly voice: ParakeetVoice | null;
  /** Whether the browser engine works on this page; production reads the page. */
  readonly browserSupport: BrowserRecognitionSupport;
  readonly className?: string;
}

/** The two engines as a radio group, with Parakeet's install inside its own option. */
export function VoiceEngineChoice({ value, onChange, voice, browserSupport, className }: VoiceEngineChoiceProps) {
  const name = useId();
  const parakeet = useParakeetInstall(voice);
  const options = [
    {
      id: 'parakeet' as const,
      label: PARAKEET_ENGINE_LABEL,
      summary: PARAKEET_ENGINE_SUMMARY,
      available: parakeet.phase !== 'unsupported',
    },
    {
      id: 'browser' as const,
      label: `${BROWSER_ENGINE_LABEL} (${BROWSER_ENGINE_DISCLOSURE})`,
      summary: BROWSER_ENGINE_SUMMARY,
      available: browserSupport.available,
    },
  ];
  return (
    <fieldset className={cn('m-0 flex min-w-0 flex-col gap-2 border-0 p-0', className)}>
      <legend className="mb-1 p-0 text-ui font-semibold">How this device turns speech into text</legend>
      {options.map(option => {
        const selected = value === option.id;
        return (
          <div
            key={option.id}
            className={cn(
              'flex flex-col gap-2 rounded-control border p-3',
              selected ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2',
            )}
          >
            <label className="flex min-h-[44px] cursor-pointer items-start gap-2">
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={selected}
                onChange={() => onChange(option.id)}
                className="mt-1 shrink-0"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className={cn('text-ui font-semibold', selected ? 'text-accent' : 'text-fg')}>
                  {option.label}
                </span>
                <span className="text-meta leading-base text-muted">{option.summary}</span>
              </span>
            </label>
            {option.id === 'parakeet' ? (
              <ParakeetInstallStep voice={voice} className="pl-6" />
            ) : option.available ? null : (
              <p className="m-0 flex items-start gap-1 pl-6 text-meta leading-base text-warn">
                <CircleSlash2 size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>{browserSupport.reason}</span>
              </p>
            )}
          </div>
        );
      })}
      <p
        className={cn(
          'm-0 flex items-start gap-1 text-meta leading-base',
          value === 'parakeet' ? 'text-ok' : value === 'browser' ? 'text-warn' : 'text-muted',
        )}
        role="status"
      >
        {value === 'parakeet' ? <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : null}
        <span>
          {value === 'parakeet' ? PARAKEET_ACTIVE_NOTE : value === 'browser' ? BROWSER_ACTIVE_NOTE : NO_ENGINE_NOTE}
        </span>
      </p>
    </fieldset>
  );
}
