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
 * THE ONE OUTPUT IS THE DRAFT, AND ONLY ON INSERT. By default, on Stop `useDictation` transcribes once,
 * cleans up once, and parks the result as a review: the panel turns into a mini box and the draft is
 * untouched. Insert calls `onDraft` exactly once with the complete next draft placed at the caret
 * as it is THEN; Discard drops the take. This bundle forwards `draft`/`selectionRef`, adapts the
 * result to the host's `onDraftChange`, closes the panel once the insertion lands, and reopens a
 * hidden panel when a take arrives so a finished transcript is never stranded.
 *
 * "INSERT STRAIGHT AWAY" (`settings.afterDictation`, a per-device choice) skips the wait: a clean take
 * goes through that same Insert path as soon as it is ready, the panel closes, and an "Inserted · Undo"
 * note (`dictation-inserted-toast.tsx`) offers one-step Undo. A failed clean-up or an empty result is
 * still parked in the panel with its reason. Push-to-talk follows the same setting.
 *
 * UNAVAILABLE IS VISIBLE. A browser without recognition still gets the mic
 * control; tapping it opens the same panel with an actionable "unavailable
 * here" reason. Hiding the control would make feature detection look like a
 * broken click path, especially on Firefox and an installed iOS PWA.
 *
 * WHAT CHANGED FROM kteam (`ui/src/components/DictationControl.tsx`): every
 * daemon-derived input is a parameter rather than a module singleton (see
 * `hooks/use-dictation.ts`). The engine — Parakeet on this device or the
 * browser's own recognition — is the person's choice in Settings › Voice; this
 * bundle only says which one is listening.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import { Mic } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMachineVoiceEngine } from '../features/fleet/setup/voice-default.ts';
import {
  type DictationShortcutBinding,
  dictationShortcutAria,
  dictationShortcutLabel,
} from '../features/settings/dictation-shortcut.ts';
import { useMachineVoiceCleanup } from '../features/settings/use-machine-voice-cleanup.ts';
import {
  type DictationAutoInsertion,
  type DictationDraftResult,
  type DictationHandle,
  type DictationPhase,
  useDictation,
} from '../hooks/use-dictation.ts';
import { browserShortcutHost, type ShortcutHost, useDictationShortcut } from '../hooks/use-dictation-shortcut.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { useDictationDebugSnapshot, useSttSettingsStore } from '../lib/store.tsx';
import type { BrowserRecognitionProvider } from '../lib/stt/browser-recognition.ts';
import type { SelectionLike } from '../lib/stt/draft.ts';
import type { MicMeterPort } from '../lib/stt/level-monitor.ts';
import {
  type DeviceClass,
  type DeviceClassGlobalLike,
  deviceClassOf,
  effectiveEngine,
} from '../lib/stt/engine-defaults.ts';
import { onDeviceModel } from '../lib/stt/model-catalog.ts';
import type { RemoteEnhancementFetch } from '../lib/stt/remote-enhancement.ts';
import { isOnDeviceEngine, isRemoteEnhancementProvider, type SttSettings } from '../lib/stt/stt-settings.ts';
import { Button } from '../shell/primitives.tsx';
import { DictationDebugSheet } from './dictation-debug-sheet.tsx';
import { DictationInsertedToast } from './dictation-inserted-toast.tsx';
import { DictationSheet, type DictationStage, dictationStage } from './dictation-sheet.tsx';
import type { InputWaveformRuntime } from './input-waveform.tsx';

export interface DictationControlProps {
  /** The paired daemon this dictation belongs to. */
  readonly daemon: DaemonConnection;
  /** Only used to mine enhancement vocabulary. Dictation works without it. */
  readonly sessionId?: string;
  /** This daemon's own client, for that vocabulary read. */
  readonly api?: Pick<IFyApiClient, 'history'>;
  /** The conversation this page already shows, oldest first; read instead of fetching history when given. */
  readonly readConversation?: () => readonly string[];
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
   * exactly once, when the person presses Insert on the reviewed transcript.
   */
  onDraftChange(result: DictationDraftResult): void;
  readonly settings: SttSettings;
  /** Browser feature/runtime seam; production feature-detects the ambient page. */
  readonly recognition?: BrowserRecognitionProvider;
  /** The meter-only microphone browser voice listens through; the page's own when omitted, `null` for none. */
  readonly meter?: MicMeterPort | null;
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
  /** Phone or computer, for the default engine (`lib/stt/engine-defaults.ts`). Read from the page when omitted. */
  readonly deviceClass?: DeviceClass;
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
export function dictationStatusCopy(
  phase: DictationPhase,
  errorMessage?: string,
  engine: DictationHandle['engine'] = 'browser',
): string {
  switch (phase) {
    case 'requesting':
      return 'Waiting for microphone permission…';
    case 'recording':
      return 'Recording…';
    case 'transcribing':
      return isOnDeviceEngine(engine) ? 'Transcribing on this device…' : 'Finishing in your browser…';
    case 'review':
      return 'Review the text, then insert it.';
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
  /** The 44px mic button; unsupported browsers use it to show the reason. */
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
    settings: deviceSettings,
    disabled,
    layout = 'compact',
    className,
    composerRef,
    now = () => performance.now(),
    clockIntervalMs = 250,
  } = props;
  // A device that has not picked an engine dictates with its machine's default (voice.yaml), if it names
  // one, and otherwise with the default for a phone or a computer (`lib/stt/engine-defaults.ts`).
  const machineEngine = useMachineVoiceEngine(deviceSettings.engine === null ? props.daemon : undefined);
  const pageDeviceClass = useMemo(() => deviceClassOf(globalThis as DeviceClassGlobalLike), []);
  const deviceClass = props.deviceClass ?? pageDeviceClass;
  const voiceCleanup = useMachineVoiceCleanup(
    isRemoteEnhancementProvider(deviceSettings.enhancementProvider) ? props.daemon : undefined,
  ).cleanup;
  const settings = useMemo(
    () =>
      deviceSettings.engine === null
        ? { ...deviceSettings, engine: effectiveEngine(null, machineEngine, deviceClass) }
        : deviceSettings,
    [deviceSettings, machineEngine, deviceClass],
  );

  const [open, setOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [wasCapturing, setWasCapturing] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [retryOnParakeet, setRetryOnParakeet] = useState(false);
  const [autoInserted, setAutoInserted] = useState<DictationAutoInsertion | null>(null);
  const dismissInserted = useCallback(() => setAutoInserted(null), []);
  const sttStore = useSttSettingsStore();
  const debug = useDictationDebugSnapshot();
  const startedAt = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;
  const effectiveDisabled = Boolean(disabled || !settings.enabled);
  const ambientShortcutHost = useMemo(
    () =>
      typeof window === 'undefined' || typeof document === 'undefined' ? null : browserShortcutHost(window, document),
    [],
  );
  // Explicit null keeps static renders unbound; omission mounts the real host.
  const shortcutHost = props.shortcutHost === undefined ? ambientShortcutHost : props.shortcutHost;

  /**
   * Panel-only UI reset. The hook already returns itself to idle after a
   * successful insertion, so this just tears down the visible flow without
   * touching a capture that is no longer running.
   */
  const closePanel = useCallback(() => {
    setOpen(false);
    setElapsedMs(0);
    setWasCapturing(false);
  }, []);

  useEffect(() => {
    if (effectiveDisabled) closePanel();
  }, [closePanel, effectiveDisabled]);

  const dictation = useDictation({
    daemon: props.daemon,
    ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
    ...(props.api === undefined ? {} : { api: props.api }),
    ...(props.readConversation === undefined ? {} : { readConversation: props.readConversation }),
    draft,
    ...(props.selectionRef === undefined ? {} : { selectionRef: props.selectionRef }),
    settings,
    voiceCleanup,
    ...(props.recognition === undefined ? {} : { recognition: props.recognition }),
    ...(props.meter === undefined ? {} : { meter: props.meter }),
    ...(props.enhancementFetch === undefined ? {} : { enhancementFetch: props.enhancementFetch }),
    disabled: effectiveDisabled,
    onDraft: result => {
      // The single, final output: Insert on the review box, or the automatic insert it stands in for.
      onDraftChange(result);
      closePanel();
    },
    onAutoInserted: setAutoInserted,
  });

  const phase = dictation.phase;
  const visibleError = dictation.error;
  const hasError = visibleError !== null;

  // Once a capturing phase has been passed through, a return to idle with no
  // insertion is a too-short clip — a dead end worth naming ("didn't catch
  // that"), not the fresh-open state.
  useEffect(() => {
    if (phase === 'requesting' || phase === 'recording' || phase === 'transcribing') setWasCapturing(true);
  }, [phase]);

  // A take that lands while the panel is hidden brings it back: the transcript is waiting on a decision.
  useEffect(() => {
    if (phase === 'review') setOpen(true);
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
    setAutoInserted(null);
    startedAt.current = nowRef.current();
    dictation.dismissError();
    dictation.start();
  }, [dictation]);

  // The inline engine switch: the store write re-renders with the new engine, and only then does the take restart.
  useEffect(() => {
    if (!retryOnParakeet || settings.engine !== 'parakeet') return;
    setRetryOnParakeet(false);
    beginRecording();
  }, [beginRecording, retryOnParakeet, settings.engine]);

  const switchToParakeet = useCallback(() => {
    if (sttStore === null) return;
    setRetryOnParakeet(true);
    sttStore.update({ engine: 'parakeet' });
  }, [sttStore]);

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
  const enabled = settings.enabled;

  // Wrap `start()` so a push-to-talk chord opens the panel before delegating to
  // the real capture start; the rest of the handle contract is preserved.
  const handle: DictationHandle = { ...dictation, start: openAndRecord };

  const shortcutComposerRef = useRef<HTMLElement | null>(null);
  useDictationShortcut({
    binding: settings.shortcut,
    handle: { phase, start: openAndRecord, stop: dictation.stop },
    composerRef: composerRef ?? shortcutComposerRef,
    host: shortcutHost,
    disabled: effectiveDisabled || !dictation.supported,
  });

  const control = enabled ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('min-h-[44px] min-w-[44px] select-none px-2', dictation.recording && 'text-err', className)}
      disabled={effectiveDisabled}
      aria-expanded={open}
      aria-pressed={dictation.recording}
      aria-keyshortcuts={dictationShortcutAria(settings.shortcut)}
      aria-label={
        flowActive
          ? 'Show dictation recorder'
          : dictation.supported
            ? 'Dictate a message'
            : 'Dictation unavailable in this browser'
      }
      title={
        flowActive
          ? 'Show the active dictation recorder'
          : dictation.supported
            ? `Dictate — ${dictationShortcutLabel(settings.shortcut)}. ${
                isOnDeviceEngine(dictation.engine)
                  ? `${onDeviceModel(dictation.engine)?.shortName ?? 'The model'} transcribes on this device`
                  : dictation.engine === 'browser'
                    ? 'Your browser’s speech service transcribes it'
                    : 'Choose a voice engine in Settings › Voice first'
              }; ${
                settings.afterDictation === 'insert'
                  ? 'the text goes into your draft when it is ready, with Undo'
                  : 'you review the text before it reaches your draft'
              }.`
            : 'Dictation is unavailable here. Open this control for the browser-specific reason.'
      }
      onClick={openAndRecord}
    >
      <Mic size={15} aria-hidden="true" />
      {layout === 'full' ? <span className="ml-1 text-ui">Dictate</span> : null}
    </Button>
  ) : null;

  const debugRecord =
    debug.enabled && dictation.review?.debugId !== undefined
      ? debug.records.find(record => record.id === dictation.review?.debugId)
      : undefined;

  const sheet = enabled ? (
    <>
      <DictationSheet
        open={open}
        stage={stage}
        elapsedMs={elapsedMs}
        liveText={dictation.liveText}
        liveInterim={dictation.liveInterim}
        livePaused={dictation.livePaused}
        inputMonitor={dictation.inputMonitor}
        engine={dictation.engine}
        {...(props.waveformRuntime ? { waveformRuntime: props.waveformRuntime } : {})}
        {...(visibleError?.code ? { errorCode: visibleError.code } : {})}
        {...(visibleError?.message ? { errorMessage: visibleError.message } : {})}
        review={dictation.review}
        insertsDirectly={settings.afterDictation === 'insert'}
        {...(debugRecord === undefined ? {} : { onDetails: () => setDetailsFor(debugRecord.id) })}
        onDismiss={dismissPanel}
        onStop={dictation.stop}
        onInsert={dictation.insert}
        onDiscard={reset}
        onCancel={reset}
        onRetry={beginRecording}
        {...(sttStore === null ? {} : { onSwitchEngine: switchToParakeet })}
      />
      <DictationInsertedToast
        insertion={autoInserted}
        draft={draft}
        onUndo={insertion => {
          onDraftChange(insertion.before);
          setAutoInserted(null);
        }}
        onDismiss={dismissInserted}
      />
      {debugRecord !== undefined && detailsFor === debugRecord.id ? (
        <DictationDebugSheet record={debugRecord} onClose={() => setDetailsFor(null)} />
      ) : null}
    </>
  ) : null;

  return { supported: enabled && dictation.supported, control, sheet, handle, shortcut: settings.shortcut, stage };
}

/** The simple mounting form: mic button and its non-modal panel together. */
export function DictationControl(props: DictationControlProps) {
  const { control, sheet } = useDictationBundle(props);
  if (!props.settings.enabled) return null;
  return (
    <>
      {control}
      {sheet}
    </>
  );
}
