/**
 * The microphone control: a self-contained bundle that hands a composer a mic
 * BUTTON and a non-modal dictation PANEL, without the composer learning anything
 * about speech.
 *
 * TAP, NOT HOLD. A single tap opens `DictationSheet` and starts recording, but
 * the panel deliberately does not trap focus or block the composer: the reader
 * can keep typing, hide the panel without cancelling, and bring it back with the
 * same mic button. Push-to-talk is still available through the reader's chord
 * (`hooks/use-dictation-shortcut.ts`), which this bundle wires to the same state
 * machine so a held key opens the panel as well as the microphone.
 *
 * WHY A HOOK THAT RETURNS NODES. The button belongs in the composer's action
 * column while the panel is fixed outside its layout; they are one state
 * machine. So `useDictationBundle` owns the state once and hands back both
 * nodes, and the host drops them wherever it likes. `DictationControl` is the
 * simple wrapper for mounting them together.
 *
 * THE ONE OUTPUT IS THE DRAFT. `useDictation` owns insertion: on Stop it
 * transcribes once, enhances once, and calls `onDraft` exactly once with the
 * complete next draft placed at the caret. There is no review step and no manual
 * Insert. This bundle forwards `draft`/`selectionRef`, adapts the result to the
 * host's `onDraftChange`, and closes the panel once the single insertion lands.
 *
 * HIDDEN, NOT DISABLED, when the browser cannot record. In an insecure context
 * `navigator.mediaDevices` is UNDEFINED — the capability is absent, not refused
 * — and a disabled button would imply "not right now".
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationControl.tsx`): every
 * daemon-derived input is a parameter rather than a module singleton (see
 * `hooks/use-dictation.ts`), and the live-caption state is gone with the rolling
 * preview that produced it, so "is there a flow to resume?" is decided by the
 * phase, the error and whether the microphone ever opened.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import { Mic } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  type DictationShortcutBinding,
  dictationShortcutAria,
  dictationShortcutLabel,
} from '../features/settings/dictation-shortcut.ts';
import {
  type DictationDraftResult,
  type DictationEngine,
  type DictationHandle,
  type DictationPhase,
  useDictation,
} from '../hooks/use-dictation.ts';
import { type ShortcutHost, useDictationShortcut } from '../hooks/use-dictation-shortcut.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { CaptureHost } from '../lib/stt/audio-capture.ts';
import type { SelectionLike } from '../lib/stt/draft.ts';
import type { RemoteEnhancementFetch } from '../lib/stt/remote-enhancement.ts';
import type { SttSettings } from '../lib/stt/stt-settings.ts';
import { Button } from '../shell/primitives.tsx';
import { DictationSheet, type DictationStage, dictationStage } from './dictation-sheet.tsx';
import type { InputWaveformRuntime } from './input-waveform.tsx';

export interface DictationControlProps {
  /** The paired daemon this dictation belongs to. */
  readonly daemon: DaemonConnection;
  /** Only used to mine enhancement vocabulary. Dictation works without it. */
  readonly sessionId?: string;
  /** This daemon's own client, for that vocabulary read. */
  readonly api?: Pick<IFyApiClient, 'history'>;
  /**
   * The live draft. Passed straight to the hook, which reads it at INSERT time
   * so text typed during the flow is preserved and the transcript lands at the
   * current caret.
   */
  readonly draft: string;
  /**
   * The composer's textarea, for the caret. Without it the transcript is
   * appended at the end — the right fallback, not an error.
   */
  readonly selectionRef?: { readonly current: SelectionLike | null };
  /**
   * Receives the COMPLETE next draft plus where the caret should sit. Called
   * exactly once, automatically, after the recording is transcribed.
   */
  onDraftChange(result: DictationDraftResult): void;
  readonly settings: SttSettings;
  /** `null` when this browser has no microphone API: render nothing. */
  readonly captureHost: CaptureHost | null;
  readonly engine?: DictationEngine;
  readonly enhancementFetch?: RemoteEnhancementFetch;
  /**
   * The keyboard and visibility surfaces push-to-talk listens to. `null` (the
   * default) leaves the chord unbound, which is what a static render wants.
   */
  readonly shortcutHost?: ShortcutHost | null;
  /**
   * The composer element the chord is allowed to fire from. Retained panes are
   * marked `aria-hidden`, so only the visible one can start a microphone.
   */
  readonly composerRef?: { current: HTMLElement | null };
  readonly disabled?: boolean;
  /**
   * `compact` keeps the 44px square icon-only, for the mobile action column.
   * `full` shows the word too, for the desktop action row.
   */
  readonly layout?: 'compact' | 'full';
  readonly className?: string;
  /** Injected by tests and the visual harness. */
  readonly waveformRuntime?: (canvas: HTMLCanvasElement) => InputWaveformRuntime | null;
  /** The elapsed clock's source and cadence. Injected by tests. */
  readonly now?: () => number;
  readonly clockIntervalMs?: number;
}

/**
 * Kept as a pure map so the vocabulary has a test of its own: recording must not
 * pretend the words are already settled, and finishing must name where it is
 * happening. The sheet inlines its own stage copy.
 */
export function dictationStatusCopy(phase: DictationPhase, errorMessage?: string): string {
  switch (phase) {
    case 'requesting':
      return 'Waiting for microphone permission…';
    case 'recording':
      return 'Recording…';
    case 'transcribing':
      return 'Transcribing on your daemon…';
    case 'error':
      return errorMessage ?? 'Dictation failed.';
    case 'idle':
      return '';
  }
}

/**
 * A mic-button press starts a NEW utterance only when there is no flow to
 * resume. This is the safety edge that makes hiding the panel non-destructive:
 * recording, transcription, empty and error states all reopen in place.
 *
 * kteam also consulted a live-caption buffer here. That buffer came from the
 * rolling on-device preview, which is not ported, so the remaining three facts
 * decide it.
 */
export function dictationTriggerStartsFresh(input: {
  phase: DictationPhase;
  hasError: boolean;
  wasCapturing: boolean;
}): boolean {
  return input.phase === 'idle' && !input.hasError && !input.wasCapturing;
}

export interface DictationBundle {
  /** False when this browser cannot record, or dictation is switched off. */
  readonly supported: boolean;
  /** The 44px mic button that opens the panel, or `null` when unsupported. */
  readonly control: ReactNode;
  /**
   * The dictation panel. Always returned (it renders nothing while closed) so
   * the host can drop it in one place regardless of layout.
   */
  readonly sheet: ReactNode;
  /**
   * The capture handle, wrapped so `start()` opens the panel too — a push-to-talk
   * chord begins dictation AND makes the panel visible.
   */
  readonly handle: DictationHandle;
  /** The same persisted binding printed in the mic tooltip. */
  readonly shortcut: DictationShortcutBinding;
  /** The visible panel stage, exposed for the host and for tests. */
  readonly stage: DictationStage;
}

export function useDictationBundle(props: DictationControlProps): DictationBundle {
  const {
    draft,
    onDraftChange,
    settings,
    captureHost,
    disabled,
    layout = 'compact',
    className,
    composerRef,
    shortcutHost = null,
    now = () => performance.now(),
    clockIntervalMs = 250,
  } = props;

  const [open, setOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [wasCapturing, setWasCapturing] = useState(false);
  const [postInsertError, setPostInsertError] = useState<DictationDraftResult['enhancementError']>(undefined);
  const startedAt = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;
  const effectiveDisabled = Boolean(disabled || !settings.enabled);

  /**
   * Panel-only UI reset. The hook already returns itself to idle after a
   * successful insertion, so this just tears down the visible flow without
   * touching a capture that is no longer running.
   */
  const closePanel = useCallback(() => {
    setOpen(false);
    setElapsedMs(0);
    setWasCapturing(false);
    setPostInsertError(undefined);
  }, []);

  useEffect(() => {
    if (effectiveDisabled) closePanel();
  }, [closePanel, effectiveDisabled]);

  const dictation = useDictation({
    daemon: props.daemon,
    ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
    ...(props.api === undefined ? {} : { api: props.api }),
    draft,
    ...(props.selectionRef === undefined ? {} : { selectionRef: props.selectionRef }),
    settings,
    captureHost,
    ...(props.engine === undefined ? {} : { engine: props.engine }),
    ...(props.enhancementFetch === undefined ? {} : { enhancementFetch: props.enhancementFetch }),
    disabled: effectiveDisabled,
    onDraft: result => {
      // The single, final output. A clean pass closes the panel immediately; a
      // non-fatal correction failure keeps only the status strip open, after the
      // raw words have already landed. There is no transcript review stage.
      onDraftChange(result);
      if (result.enhancementError) setPostInsertError(result.enhancementError);
      else closePanel();
    },
  });

  const phase = dictation.phase;
  const visibleError = postInsertError ?? dictation.error;
  const hasError = visibleError !== null && visibleError !== undefined;

  // Once a capturing phase has been passed through, a return to idle with no
  // insertion is a too-short clip — a dead end worth naming ("didn't catch
  // that"), not the fresh-open state.
  useEffect(() => {
    if (phase === 'requesting' || phase === 'recording' || phase === 'transcribing') setWasCapturing(true);
  }, [phase]);

  // The elapsed clock runs only while the microphone is open, and is cleared the
  // moment recording ends. 250 ms is smooth enough for an m:ss readout and cheap.
  useEffect(() => {
    if (phase !== 'recording') return;
    const tick = (): void => setElapsedMs(Math.max(0, nowRef.current() - startedAt.current));
    tick();
    const timer = setInterval(tick, Math.max(1, clockIntervalMs));
    return () => clearInterval(timer);
  }, [clockIntervalMs, phase]);

  const reset = useCallback(() => {
    dictation.cancel();
    closePanel();
  }, [closePanel, dictation]);

  const beginRecording = useCallback(() => {
    setElapsedMs(0);
    setWasCapturing(false);
    startedAt.current = nowRef.current();
    setPostInsertError(undefined);
    dictation.dismissError();
    dictation.start();
  }, [dictation]);

  const openAndRecord = useCallback(() => {
    if (effectiveDisabled) return;
    setOpen(true);
    if (dictationTriggerStartsFresh({ phase, hasError, wasCapturing })) beginRecording();
  }, [beginRecording, effectiveDisabled, hasError, phase, wasCapturing]);

  const dismissPanel = useCallback(() => {
    // Hiding is intentionally not cancellation. The recorder and the elapsed
    // clock continue; the mic button reopens this exact flow.
    setOpen(false);
  }, []);

  const stage = dictationStage({ phase, hasError, wasCapturing });
  const flowActive = !dictationTriggerStartsFresh({ phase, hasError, wasCapturing });
  const enabledAndSupported = settings.enabled && dictation.supported;

  // Wrap `start()` so a push-to-talk chord opens the panel before delegating to
  // the real capture start; the rest of the handle contract is preserved.
  const handle: DictationHandle = { ...dictation, start: openAndRecord };

  const shortcutComposerRef = useRef<HTMLElement | null>(null);
  useDictationShortcut({
    binding: settings.shortcut,
    handle: { phase, start: openAndRecord, stop: dictation.stop },
    composerRef: composerRef ?? shortcutComposerRef,
    host: shortcutHost,
    disabled: effectiveDisabled || !enabledAndSupported,
  });

  const control = enabledAndSupported ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('min-h-[44px] min-w-[44px] select-none px-2', dictation.recording && 'text-err', className)}
      disabled={effectiveDisabled}
      aria-expanded={open}
      aria-pressed={dictation.recording}
      aria-keyshortcuts={dictationShortcutAria(settings.shortcut)}
      aria-label={flowActive ? 'Show dictation recorder' : 'Dictate a message'}
      title={
        flowActive
          ? 'Show the active dictation recorder'
          : `Dictate — ${dictationShortcutLabel(settings.shortcut)}. Your words go to your own daemon and land in your draft. Nothing is ever sent for you.`
      }
      onClick={openAndRecord}
    >
      <Mic size={15} aria-hidden="true" />
      {layout === 'full' ? <span className="ml-1 text-ui">Dictate</span> : null}
    </Button>
  ) : null;

  const sheet = enabledAndSupported ? (
    <DictationSheet
      open={open}
      stage={stage}
      elapsedMs={elapsedMs}
      inputMonitor={dictation.inputMonitor}
      {...(props.waveformRuntime ? { waveformRuntime: props.waveformRuntime } : {})}
      {...(visibleError?.code ? { errorCode: visibleError.code } : {})}
      {...(visibleError?.message ? { errorMessage: visibleError.message } : {})}
      onDismiss={dismissPanel}
      onStop={dictation.stop}
      onCancel={reset}
      onRetry={beginRecording}
    />
  ) : null;

  return { supported: enabledAndSupported, control, sheet, handle, shortcut: settings.shortcut, stage };
}

/** The simple mounting form: mic button and its non-modal panel together. */
export function DictationControl(props: DictationControlProps) {
  const { supported, control, sheet } = useDictationBundle(props);
  if (!supported) return null;
  return (
    <>
      {control}
      {sheet}
    </>
  );
}
