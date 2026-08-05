/**
 * The dictation MINI PANEL — tap the mic, keep typing, speak, and watch the
 * words land in your draft on their own.
 *
 * NON-MODAL IS THE PRODUCT REQUIREMENT, and kteam's `DESIGN-side-pane-tabs.md`
 * reasoning applies here too: the first single-tap redesign used a bottom sheet,
 * which was clearer than hold-to-talk but trapped focus and blocked the exact
 * workflow the reader wanted to continue while recording. This panel has no
 * scrim, no inert page, no focus trap and no mount-time focus call. It is a
 * single slim strip anchored directly above the composer, and hiding it does not
 * cancel the recording; the mic button brings it back.
 *
 * A READ-ONLY CAPTION, NOT AN EDITOR. There is no textarea, no review step and
 * no Insert button — on Stop the hook transcribes once, enhances once, and drops
 * the result straight into the draft. The panel only says what is happening and
 * offers Stop / Retry / Cancel / Hide.
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationSheet.tsx`), and WHY.
 *
 *   1. WHERE THE AUDIO GOES. Browser SpeechRecognition owns capture. Ferretry
 *      never uploads microphone audio to its daemon, but some browser engines
 *      use their vendor's online recognition service, so the copy promises the
 *      former and does not falsely promise universal offline processing.
 *   2. LIVE WORDS COME FROM THE BROWSER. Interim SpeechRecognition results fill
 *      `liveText`; the completed result, not a provisional caption, is what the
 *      controller inserts.
 *   3. THE INPUT METER REMAINS AN OPTIONAL VISUAL SEAM. kteam's sheet declared an
 *      `inputMonitor` prop, never destructured it, and `InputWaveform` was
 *      imported by nothing except its own test. It is still usable by isolated
 *      visual fixtures, but production does not open a second microphone stream
 *      merely to paint a waveform beside browser-owned recognition.
 */

import { AlertCircle, EyeOff, Loader2, Mic, RotateCcw, Square, X } from 'lucide-react';
import { useId } from 'react';
import type { DictationPhase } from '../hooks/use-dictation.ts';
import { cn } from '../lib/class-names.ts';
import { Button } from '../shell/primitives.tsx';
import { type CaptureMonitor, InputWaveform, type InputWaveformRuntime } from './input-waveform.tsx';

/**
 * The visible step, derived from the capture phase plus whether the mic ever
 * opened. Pure and exported so the whole "what does the reader see right now"
 * rule has a test instead of living in JSX. `wasCapturing` distinguishes "just
 * opened, waiting for the mic" from "recorded, but the clip was too short to
 * keep" — both are `idle`, and only the second is a dead end worth telling the
 * reader about. There is no `review` stage: a landed transcript is inserted
 * automatically and the panel closes itself.
 */
export type DictationStage = 'starting' | 'recording' | 'transcribing' | 'empty' | 'error';

export function dictationStage(input: {
  phase: DictationPhase;
  hasError: boolean;
  wasCapturing: boolean;
}): DictationStage {
  if (input.hasError || input.phase === 'error') return 'error';
  if (input.phase === 'transcribing') return 'transcribing';
  if (input.phase === 'requesting') return 'starting';
  if (input.phase === 'recording') return 'recording';
  if (input.wasCapturing) return 'empty';
  return 'starting';
}

/**
 * m:ss from milliseconds. Clamps negatives to zero and never shows a partial
 * leading digit on the seconds.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface DictationFailureCopy {
  readonly title: string;
  readonly hint?: string;
}

/**
 * A short, plain title for each failure, chosen from the error CODE (stable)
 * rather than the message (not). The message itself is shown underneath — this
 * is only the headline and the one actionable hint.
 *
 * The vocabulary is what can actually REACH this panel: the visible half of
 * `BrowserRecognitionErrorCode` (`lib/stt/browser-recognition.ts`) plus the
 * `enhancement-` prefix the hook attaches to a post-transcription correction
 * failure. Two absences are deliberate:
 *
 *   1. `aborted` is a cancellation, not a failed take, and `use-dictation.ts`
 *      converts it to idle in BOTH places the session can report it — the
 *      `onFailure` callback while recognition is still open, and the rejection
 *      of `finish()`. A case here would be copy no reader could ever see, and
 *      writing one would suggest the panel decides that, which it does not.
 *   2. The capture vocabulary that died with the daemon engine —
 *      `audio-unavailable`, `no-media-devices`, `capture-failed`, `too-long` —
 *      has no producer left. Nothing raises it, so it falls to the default
 *      headline like any other unknown code rather than living on as copy that
 *      proves only that a test can call this function with a string.
 */
export function dictationFailureCopy(code: string | undefined): DictationFailureCopy {
  if (code?.startsWith('enhancement-')) {
    return {
      title: 'Raw dictation kept',
      hint: 'Correction failed, but the unmodified transcript was already added to your draft.',
    };
  }
  switch (code) {
    case 'permission-denied':
      return {
        title: 'Microphone blocked',
        hint: 'Allow microphone access for this site in your browser, then try again.',
      };
    case 'no-microphone':
      return { title: 'No microphone found' };
    case 'recognition-unavailable':
      return { title: 'Dictation unavailable here' };
    case 'recognition-network':
      return {
        title: 'Browser speech service unreachable',
        hint: 'Check this device’s connection, then try again.',
      };
    case 'recognition-failed':
      return { title: 'Browser recognition failed', hint: 'Try again or use another supported browser.' };
    case 'bad-audio':
      return { title: "Didn't catch that", hint: 'No usable audio was captured. Try again.' };
    default:
      return { title: 'Dictation failed' };
  }
}

export interface DictationSheetProps {
  readonly open: boolean;
  readonly stage: DictationStage;
  /** Milliseconds elapsed in the CURRENT recording. Ignored off `recording`. */
  readonly elapsedMs: number;
  /**
   * A rolling read-only browser-recognition caption. The panel NEVER edits it —
   * what gets inserted is the finished transcript, not this provisional text.
   */
  readonly liveText?: string;
  /** A read-only analyser branch off the recorder's own stream and audio graph. */
  readonly inputMonitor?: CaptureMonitor | null;
  /** Injected by tests and the visual harness; the browser runtime otherwise. */
  readonly waveformRuntime?: (canvas: HTMLCanvasElement) => InputWaveformRuntime | null;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Hide only. Recording and transcription continue in the background. */
  onDismiss(): void;
  /** Stop recording; the hook finishes and inserts on its own. */
  onStop(): void;
  /** Throw the recording away and close. */
  onCancel(): void;
  /** Start over from a fresh recording (empty, error). */
  onRetry(): void;
}

/** Every strip action is a 44px square: this panel is used one-handed. */
const ACTION_CLASS = 'min-h-[44px] min-w-[44px] shrink-0 justify-center p-0';

/**
 * The recording indicator: a pulsing dot the reader reads as "live" without a
 * word, plus the word for assistive tech.
 */
function LiveDot() {
  return (
    <span className="relative inline-flex h-3 w-3 shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-err opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex h-3 w-3 rounded-full bg-err" />
    </span>
  );
}

/**
 * The one line of prose in the strip. Pure, so its wording has a test.
 *
 * The blank-recording line is where the vendor disclosure has to live. "Handled
 * by this browser" reads to most people as "on this device", and several engines
 * send the audio to their vendor's online service instead — a fact that was only
 * ever stated in `sr-only` text and in Settings, i.e. exactly where a sighted
 * reader deciding whether to speak will not find it. It stays compact because
 * this line is truncated to one row (the full text is the strip's `title`), and
 * the `sr-only` description below still carries the complete statement.
 */
export function dictationStripStatus(
  stage: DictationStage,
  liveText: string,
  errorMessage: string | undefined,
  failure: DictationFailureCopy,
): string {
  const preview = liveText.trim();
  switch (stage) {
    case 'recording':
      if (preview) return preview;
      return 'Speak, then press Stop. This browser may use its vendor’s online speech service; Ferretry only updates your draft.';
    case 'transcribing':
      return `Finishing in your browser and correcting once… ${
        preview ? `Last heard: ${preview}` : 'The result will be added to your draft.'
      }`;
    case 'empty':
      return 'No speech was captured. Record again when you are ready.';
    case 'error':
      return [errorMessage ?? failure.title, failure.hint, preview ? `Last heard: ${preview}` : undefined]
        .filter(Boolean)
        .join(' ');
    case 'starting':
      return 'Opening browser speech recognition…';
  }
}

export function DictationSheet({
  open,
  stage,
  elapsedMs,
  liveText = '',
  inputMonitor = null,
  waveformRuntime,
  errorCode,
  errorMessage,
  onDismiss,
  onStop,
  onCancel,
  onRetry,
}: DictationSheetProps) {
  const baseId = useId();
  const enhancementFailure = errorCode?.startsWith('enhancement-') ?? false;
  const titleId = `${baseId}-title`;
  const safetyId = `${baseId}-safety`;

  const failure = dictationFailureCopy(errorCode);
  const title =
    stage === 'transcribing'
      ? 'Finishing in browser'
      : stage === 'recording'
        ? 'Recording'
        : stage === 'error'
          ? failure.title
          : stage === 'empty'
            ? "Didn't catch that"
            : 'Opening microphone';
  const status = dictationStripStatus(stage, liveText, errorMessage, failure);

  if (!open) return null;

  return (
    <section
      id={`${baseId}-panel`}
      data-dictation-panel="non-modal"
      aria-labelledby={titleId}
      aria-describedby={safetyId}
      onKeyDown={event => {
        // Local Escape only: the panel must never install a document-level
        // handler that intercepts keys while the reader is typing elsewhere.
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onDismiss();
      }}
      className={cn(
        'absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-panel border border-l-heavy border-border bg-surface font-ui shadow-panel',
        stage === 'recording' && 'border-l-err',
        (stage === 'starting' || stage === 'transcribing') && 'border-l-accent',
        (stage === 'empty' || stage === 'error') && 'border-l-warn',
      )}
    >
      <div className="flex min-h-[56px] w-full min-w-0 items-center gap-xs px-2 py-1.5">
        {stage === 'recording' ? (
          <LiveDot />
        ) : stage === 'transcribing' ? (
          <Loader2
            size={16}
            aria-hidden="true"
            className="shrink-0 animate-spin text-accent motion-reduce:animate-none"
          />
        ) : stage === 'error' ? (
          <AlertCircle size={16} aria-hidden="true" className="shrink-0 text-warn" />
        ) : (
          <Mic size={16} aria-hidden="true" className="shrink-0 text-fg-soft" />
        )}
        <span id={titleId} className="sr-only">
          {title}
        </span>
        {stage === 'recording' && (
          <span className="mono shrink-0 tabular-nums text-ui text-muted" aria-hidden="true">
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <p
          data-live-transcript={liveText.trim() ? 'preview' : 'waiting'}
          title={status}
          className={cn(
            'm-0 min-w-0 flex-1 leading-base text-fg',
            stage === 'error' ? 'whitespace-normal break-words text-meta' : 'truncate text-ui',
          )}
        >
          {status}
        </p>

        {stage === 'recording' && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className={ACTION_CLASS}
            aria-label="Stop recording and add text to your draft"
            title="Stop and add to draft"
            onClick={onStop}
          >
            <Square size={15} aria-hidden="true" />
          </Button>
        )}
        {(stage === 'empty' || (stage === 'error' && !enhancementFailure)) && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className={ACTION_CLASS}
            aria-label={stage === 'empty' ? 'Record again' : 'Try again'}
            title={stage === 'empty' ? 'Record again' : 'Try again'}
            onClick={onRetry}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={ACTION_CLASS}
          aria-label={stage === 'empty' || enhancementFailure ? 'Close dictation' : 'Cancel dictation'}
          title={stage === 'empty' || enhancementFailure ? 'Close dictation' : 'Cancel dictation'}
          onClick={onCancel}
        >
          <X size={15} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={ACTION_CLASS}
          aria-label="Hide dictation panel; recording continues"
          title="Hide this panel — recording continues"
          onClick={onDismiss}
        >
          <EyeOff size={15} aria-hidden="true" />
        </Button>
      </div>

      {/* The live input meter, only while the microphone is actually open. */}
      {stage === 'recording' && inputMonitor !== null && (
        <div className="px-2 pb-1.5">
          <InputWaveform monitor={inputMonitor} {...(waveformRuntime ? { runtime: waveformRuntime } : {})} />
        </div>
      )}

      {/* Announce stage changes, but never each provisional rewrite. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {stage === 'recording'
          ? 'Recording'
          : stage === 'transcribing'
            ? 'Finishing transcription in your browser, then adding it to your draft'
            : stage === 'empty'
              ? 'No speech was captured'
              : stage === 'error'
                ? enhancementFailure
                  ? `Enhancement failed; raw dictation was added: ${errorMessage ?? failure.title}`
                  : `Dictation failed: ${errorMessage ?? failure.title}`
                : 'Starting'}
      </span>
      <span id={safetyId} className="sr-only">
        Ferretry never sends microphone audio to your daemon. Your browser may use its own online speech service.
        Dictation only updates your draft and is never sent automatically.
      </span>
    </section>
  );
}
