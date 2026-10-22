/**
 * The dictation MINI PANEL — tap the mic, keep typing, speak, then review the words in a mini box
 * and choose whether they go into your draft.
 *
 * NON-MODAL IS THE PRODUCT REQUIREMENT, and kteam's `DESIGN-side-pane-tabs.md`
 * reasoning applies here too: the first single-tap redesign used a bottom sheet,
 * which was clearer than hold-to-talk but trapped focus and blocked the exact
 * workflow the reader wanted to continue while recording. This panel has no
 * scrim, no inert page, no focus trap and no mount-time focus call. It is a
 * single slim strip anchored directly above the composer, and hiding it does not
 * cancel the recording; the mic button brings it back.
 *
 * WHILE RECORDING IT IS A READ-ONLY CAPTION: the sound wave, plus live words only when the
 * experimental toggle is on, and Stop / Cancel / Hide. Typing in the composer still works.
 *
 * ON STOP THE SAME PANEL BECOMES THE REVIEW MINI BOX (`dictation-review-box.tsx`). The hook
 * transcribes once, cleans up once (if cleanup is on) and PARKS the result; nothing reaches the draft
 * until the person presses Insert, which puts it at the composer's caret and never replaces the
 * draft. Discard throws it away, Retry records again, and when cleanup changed the words a quiet
 * switch offers the raw transcript instead. A hidden panel reopens by itself when the take lands, so
 * a finished transcript is never stranded out of sight.
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationSheet.tsx`), and WHY.
 *
 *   1. WHERE THE AUDIO GOES DEPENDS ON THE ENGINE, and the strip says which.
 *      Ferretry never uploads microphone audio to its daemon. With Parakeet the
 *      audio never leaves the device, and the strip says so; with phone/browser
 *      voice the browser sends it to its vendor, and the strip says THAT instead.
 *   2. LIVE WORDS FROM BOTH ENGINES. Interim SpeechRecognition results fill
 *      `liveText`; Parakeet is not a streaming model, so only when the person has
 *      switched on "Live words (experimental)" (off by default) does it
 *      re-transcribe a rolling window (`lib/stt/near-live.ts`): words two passes
 *      agreed on read normally, the provisional tail (`liveInterim`) is greyed, and
 *      a device too slow to keep up says "live words paused — device too slow".
 *      The caption shows its last two lines, where the new words land. Either way the
 *      completed result, not a provisional caption, is what the review box offers.
 *   3. THE INPUT METER IS WIRED FOR EVERY ENGINE. kteam's sheet declared an
 *      `inputMonitor` prop, never destructured it, and `InputWaveform` was
 *      imported by nothing except its own test, so no bars ever showed. Here
 *      `useDictation` hands one in whichever engine is recording: Parakeet taps
 *      the stream it is already recording, and browser voice, which owns its
 *      microphone and exposes no level, gets a meter-only stream beside it
 *      (`lib/stt/level-monitor.ts`). The bars say "we are capturing what you
 *      say"; they are flat when nothing is.
 */

import { AlertCircle, EyeOff, Loader2, Mic, RotateCcw, Square, X } from 'lucide-react';
import { useId } from 'react';
import type { DictationPhase, DictationReview } from '../hooks/use-dictation.ts';
import { cn } from '../lib/class-names.ts';
import type { CaptureMonitor } from '../lib/stt/level-monitor.ts';
import { onDeviceModel } from '../lib/stt/model-catalog.ts';
import { NEAR_LIVE_PAUSED_COPY } from '../lib/stt/near-live.ts';
import { type DictationEngineId, isOnDeviceEngine } from '../lib/stt/stt-settings.ts';
import { Button } from '../shell/primitives.tsx';
import { DictationReviewBox } from './dictation-review-box.tsx';
import { InputWaveform, type InputWaveformRuntime } from './input-waveform.tsx';

/**
 * The visible step, derived from the capture phase plus whether the mic ever
 * opened. Pure and exported so the whole "what does the reader see right now"
 * rule has a test instead of living in JSX. `wasCapturing` distinguishes "just
 * opened, waiting for the mic" from "recorded, but the clip was too short to
 * keep" — both are `idle`, and only the second is a dead end worth telling the
 * reader about. `review` is the landed transcript waiting for Insert or Discard.
 */
export type DictationStage = 'starting' | 'recording' | 'transcribing' | 'review' | 'empty' | 'error';

export function dictationStage(input: {
  phase: DictationPhase;
  hasError: boolean;
  wasCapturing: boolean;
}): DictationStage {
  if (input.hasError || input.phase === 'error') return 'error';
  if (input.phase === 'review') return 'review';
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

/** The engine the strip is talking about. `null` (unchosen) reads like browser voice: it never promises privacy. */
type StripEngine = DictationEngineId | null;

/** The on-device model's name for sentences ("Parakeet transcribes…"). */
const modelName = (engine: StripEngine): string => onDeviceModel(engine)?.shortName ?? 'The model';

/**
 * A short, plain title for each failure, chosen from the error CODE (stable)
 * rather than the message (not). The message itself is shown underneath — this
 * is only the headline and the one actionable hint.
 *
 * The vocabulary is what can actually REACH this panel: the visible half of
 * `BrowserRecognitionErrorCode` (`lib/stt/browser-recognition.ts`). A failed cleanup is not here —
 * it is not a failed take; the review box shows the raw words with the reason. Two absences are
 * deliberate:
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
export function dictationFailureCopy(code: string | undefined, engine: StripEngine = 'browser'): DictationFailureCopy {
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
      return isOnDeviceEngine(engine)
        ? {
            title: 'Transcription failed',
            hint: `Try again. If it keeps failing, remove ${modelName(engine)} in Settings › Voice and install it again.`,
          }
        : { title: 'Browser recognition failed', hint: 'Try again or use another supported browser.' };
    case 'model-not-installed':
      return {
        title: `${isOnDeviceEngine(engine) ? modelName(engine) : 'Parakeet'} is not installed`,
        hint: 'Install it in Settings › Voice, or choose phone/browser voice there.',
      };
    case 'engine-not-chosen':
      return { title: 'Choose a voice engine' };
    case 'bad-audio':
      return engine === 'browser'
        ? { title: "Didn't catch that", hint: 'Try again, or switch to Parakeet in Settings › Voice.' }
        : { title: "Didn't catch that", hint: 'No usable audio was captured. Try again.' };
    default:
      return { title: 'Dictation failed' };
  }
}

export interface DictationSheetProps {
  readonly open: boolean;
  /** Opens the debug record of this take; given only while dictation debug is on and the record is still held. */
  readonly onDetails?: () => void;
  readonly stage: DictationStage;
  /** Milliseconds elapsed in the CURRENT recording. Ignored off `recording`. */
  readonly elapsedMs: number;
  /**
   * A rolling read-only browser-recognition caption. The panel NEVER edits it —
   * what gets inserted is the finished transcript, not this provisional text.
   */
  readonly liveText?: string;
  /** The provisional tail of `liveText` (Parakeet near-live), greyed. Always a suffix of it. */
  readonly liveInterim?: string;
  /** Parakeet near-live words paused for this take: the device could not keep up. */
  readonly livePaused?: boolean;
  /** A read-only analyser branch off the recorder's own stream and audio graph. */
  readonly inputMonitor?: CaptureMonitor | null;
  /** Injected by tests and the visual harness; the browser runtime otherwise. */
  readonly waveformRuntime?: (canvas: HTMLCanvasElement) => InputWaveformRuntime | null;
  /** Which engine is dictating, so the strip says where the audio goes. */
  readonly engine?: StripEngine;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** The finished take, present in stage `review`. */
  readonly review?: DictationReview | null;
  /** Hide only. Recording and transcription continue in the background. */
  onDismiss(): void;
  /** Stop recording; the hook finishes and parks the transcript for review. */
  onStop(): void;
  /** Put the reviewed text into the draft at the caret. */
  onInsert(text: string): void;
  /** Drop the reviewed take; the draft is untouched. */
  onDiscard(): void;
  /** Throw the recording away and close. */
  onCancel(): void;
  /** Start over from a fresh recording (empty, error). */
  onRetry(): void;
  /** Offered beside a browser-voice take that heard speech but returned no words: change engine and record again. */
  onSwitchEngine?(): void;
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
  engine: StripEngine = 'browser',
  livePaused = false,
): string {
  const preview = liveText.trim();
  const onDevice = isOnDeviceEngine(engine);
  const paused = onDevice && livePaused;
  switch (stage) {
    case 'recording':
      if (preview) return paused ? `${preview} · ${NEAR_LIVE_PAUSED_COPY}` : preview;
      return onDevice
        ? `Speak, then press Stop. ${modelName(engine)} transcribes on this device; audio never leaves it.`
        : 'Speak, then press Stop. Your browser sends this audio to its vendor’s servers; Ferretry only shows you the text.';
    case 'transcribing':
      if (onDevice)
        return preview
          ? `Finishing on this device and correcting once… Last heard: ${preview}`
          : 'Transcribing on this device and correcting once… You will review the result before it reaches your draft.';
      return `Finishing in your browser and correcting once… ${
        preview ? `Last heard: ${preview}` : 'You will review the result before it reaches your draft.'
      }`;
    case 'review':
      return 'Review the text, then insert it into your draft.';
    case 'empty':
      return 'No speech was captured. Record again when you are ready.';
    case 'error':
      return [errorMessage ?? failure.title, failure.hint, preview ? `Last heard: ${preview}` : undefined]
        .filter(Boolean)
        .join(' ');
    case 'starting':
      return onDevice ? 'Opening the microphone…' : 'Opening browser speech recognition…';
  }
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Split the caption into the words that will not change and the greyed tail that may. A tail that
 * is not a suffix of the line is ignored rather than trusted: the whole line then reads as settled.
 */
export function splitLiveCaption(liveText: string, liveInterim: string): { settled: string; interim: string } {
  const line = liveText.trim();
  const interim = liveInterim.trim();
  if (interim === '' || !line.endsWith(interim)) return { settled: line, interim: '' };
  return { settled: line.slice(0, line.length - interim.length).trim(), interim };
}

/**
 * The recording caption: settled words, then the greyed provisional tail.
 * It is at most two lines, pinned to its END — older words scroll off the top — so the newest words
 * stay in view as the caption grows, even on a phone.
 */
function LiveCaption({ settled, interim }: { settled: string; interim: string }) {
  return (
    <span className="flex max-h-[2lh] min-w-0 flex-col justify-end overflow-hidden">
      <span className="shrink-0 whitespace-normal break-words">
        {settled && <span data-live-words="committed">{settled}</span>}
        {settled && interim ? ' ' : null}
        {interim && (
          <span data-live-words="interim" className="text-muted">
            {interim}
          </span>
        )}
      </span>
    </span>
  );
}

export function DictationSheet({
  open,
  stage,
  elapsedMs,
  liveText = '',
  liveInterim = '',
  livePaused = false,
  inputMonitor = null,
  waveformRuntime,
  errorCode,
  errorMessage,
  engine = 'browser',
  onDetails,
  onDismiss,
  review = null,
  onStop,
  onInsert,
  onDiscard,
  onCancel,
  onRetry,
  onSwitchEngine,
}: DictationSheetProps) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const safetyId = `${baseId}-safety`;

  const onDevice = isOnDeviceEngine(engine);
  const failure = dictationFailureCopy(errorCode, engine);
  const title =
    stage === 'transcribing'
      ? onDevice
        ? 'Transcribing on this device'
        : 'Finishing in browser'
      : stage === 'recording'
        ? 'Recording'
        : stage === 'review'
          ? 'Review dictation'
          : stage === 'error'
            ? failure.title
            : stage === 'empty'
              ? "Didn't catch that"
              : 'Opening microphone';
  const status = dictationStripStatus(stage, liveText, errorMessage, failure, engine, livePaused);
  const caption = splitLiveCaption(liveText, liveInterim);
  const showCaption = stage === 'recording' && caption.settled + caption.interim !== '';

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
        // On a finished take it is Discard (the review's own Escape); otherwise it only hides.
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (stage === 'review') onDiscard();
        else onDismiss();
      }}
      className={cn(
        'absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-panel border border-l-heavy border-border bg-surface font-ui shadow-panel',
        stage === 'recording' && 'border-l-err',
        (stage === 'starting' || stage === 'transcribing' || stage === 'review') && 'border-l-accent',
        (stage === 'empty' || stage === 'error') && 'border-l-warn',
      )}
    >
      {stage === 'review' && review !== null ? (
        <>
          <span id={titleId} className="sr-only">
            {title}
          </span>
          <DictationReviewBox
            key={review.id}
            review={review}
            onInsert={onInsert}
            onDiscard={onDiscard}
            onRetry={onRetry}
            {...(onDetails === undefined ? {} : { onDetails })}
          />
        </>
      ) : (
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
            {showCaption ? <LiveCaption settled={caption.settled} interim={caption.interim} /> : status}
          </p>

          {stage === 'recording' && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              className={ACTION_CLASS}
              aria-label="Stop recording and review the text"
              title="Stop and review the text"
              onClick={onStop}
            >
              <Square size={15} aria-hidden="true" />
            </Button>
          )}
          {(stage === 'empty' || stage === 'error') && (
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
            aria-label={stage === 'empty' ? 'Close dictation' : 'Cancel dictation'}
            title={stage === 'empty' ? 'Close dictation' : 'Cancel dictation'}
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
      )}

      {stage === 'error' && errorCode === 'bad-audio' && engine === 'browser' && onSwitchEngine !== undefined && (
        <div className="flex px-2 pb-1.5">
          <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={onSwitchEngine}>
            Use Parakeet and record again
          </Button>
        </div>
      )}

      {/* Parakeet could not keep up: its own full-width row, so a phone shows it beside the words. */}
      {stage === 'recording' && onDevice && livePaused && (
        <p role="status" data-live-words="paused" className="m-0 px-2 pb-1.5 text-meta leading-base text-warn">
          {`${capitalise(NEAR_LIVE_PAUSED_COPY)}. Stop still transcribes everything you said.`}
        </p>
      )}

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
            ? onDevice
              ? 'Transcribing on this device; you will review it before it reaches your draft'
              : 'Finishing transcription in your browser; you will review it before it reaches your draft'
            : stage === 'review'
              ? 'Transcript ready. Review it, then insert or discard it'
              : stage === 'empty'
                ? 'No speech was captured'
                : stage === 'error'
                  ? `Dictation failed: ${errorMessage ?? failure.title}`
                  : 'Starting'}
      </span>
      <span id={safetyId} className="sr-only">
        {onDevice
          ? `${modelName(engine)} transcribes on this device: audio never leaves it, and Ferretry never sends it to your daemon.`
          : 'Ferretry never sends microphone audio to your daemon, but your browser sends it to its vendor’s servers to transcribe it.'}{' '}
        Nothing reaches your draft until you press Insert, and dictation is never sent automatically.
      </span>
    </section>
  );
}
