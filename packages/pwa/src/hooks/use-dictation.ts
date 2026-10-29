/**
 * Dictation: one recognition session, one transcript held for review, and exactly one way for
 * text to leave it.
 *
 * There is no `onSubmit`, no `onSend`, and no path from recognised words to a
 * message being sent. On Stop the hook transcribes once and cleans up once, then PARKS the result
 * as `review` (phase `review`) — nothing reaches the draft yet. `insert(text)` is the only way
 * out: it calls `onDraft` once with the COMPLETE next draft and caret, placed where the caret
 * is at THAT moment (so typing while the box was open is preserved). `discard()` drops it.
 *
 * `settings.afterDictation === 'insert'` skips the wait: when the cleaned text is ready it goes
 * through that same `insert` path once, and `onInserted` hands the host the draft before and
 * after so it can offer Undo. A take that failed to clean up, or came back empty, is still parked
 * for review with its reason — an automatic insert never swallows a problem.
 *
 * ENGINES CHOSEN BY THE PERSON (`settings.engine`), none a fallback for
 * another:
 *
 *   - an ON-DEVICE model (`parakeet`, or any other catalog entry in
 *     `lib/stt/model-catalog.ts`) records with this page's microphone and
 *     transcribes in its speech worker, through the voice the registry holds
 *     for it (`lib/stt/on-device-voices.ts`). Audio never leaves the device.
 *     It needs the model installed first, and says so rather than downloading
 *     anything.
 *   - `browser` hands the microphone to the browser's own SpeechRecognition
 *     (`lib/stt/browser-recognition.ts`), which on Chrome, Android and Safari
 *     sends the audio to the browser vendor's servers.
 *
 * Until one is chosen, the mic says so instead of picking for them. Either way
 * `start()` runs synchronously from the mic button so the permission prompt is
 * attributed to the gesture, and no audio is ever sent to a Ferretry daemon.
 *
 * Every async boundary checks a generation. A duration limit and Stop can race,
 * a cancelled browser can deliver a late result, and enhancement can resolve
 * after unmount. Only the first current owner can commit.
 *
 * Hosted clean-up (Groq or Cerebras) goes STRAIGHT from this browser to the provider when this device
 * holds a key for it (Settings › This device › Speed-up keys, `lib/stt/speedup-keys.ts`); only without
 * one does it ask the paired daemon, which spends a key from its own secret store. The conversation it
 * reads is the transcript this page already shows, when the host hands it in. Local correction never
 * sends the transcript anywhere, and audio cannot leave through either path.
 */

import { CLEANUP_PROVIDERS, type CleanupTrace, type IFyApiClient } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import {
  useDaemonFetch,
  useDictationDebug,
  useOnDeviceVoices,
  useParakeetVoice,
  useSpeedupKeys,
  useTranscriptionLog,
} from '../lib/store.tsx';
import {
  BrowserRecognitionError,
  type BrowserRecognitionProvider,
  BrowserRecognitionSession,
  type BrowserRecognitionSessionLike,
  type BrowserRecognitionSessionOptions,
  browserRecognitionErrorFrom,
  browserRecognitionProvider,
} from '../lib/stt/browser-recognition.ts';
import { DEVICE_KEYS_PLACE, requestDeviceCleanup } from '../lib/stt/device-cleanup.ts';
import type { DictationDebugLog } from '../lib/stt/dictation-debug.ts';
import {
  type CleanupTiming,
  cleanupDetailsOf,
  type DictationTimeline,
  DictationTimelineRecorder,
  withInsertion,
} from '../lib/stt/dictation-timeline.ts';
import { insertTranscript, readSelection, type SelectionLike } from '../lib/stt/draft.ts';
import { enhance } from '../lib/stt/enhancement.ts';
import {
  browserMicMeter,
  type CaptureMonitor,
  type MicMeter,
  type MicMeterGlobalLike,
  type MicMeterPort,
} from '../lib/stt/level-monitor.ts';
import { onDeviceModel } from '../lib/stt/model-catalog.ts';
import { joinWords, type NearLiveState } from '../lib/stt/near-live.ts';
import type { OnDeviceVoice } from '../lib/stt/on-device-voice.ts';
import type { OnDeviceVoices } from '../lib/stt/on-device-voices.ts';
import type { ParakeetVoice } from '../lib/stt/parakeet-voice.ts';
import {
  type RemoteEnhancementError,
  type RemoteEnhancementFetch,
  type RemoteEnhancementResult,
  requestRemoteEnhancement,
} from '../lib/stt/remote-enhancement.ts';
import type { DeviceSpeedupKeys } from '../lib/stt/speedup-keys.ts';
import {
  isOnDeviceEngine,
  isRemoteEnhancementProvider,
  type SttSettings,
  sttDictionary,
} from '../lib/stt/stt-settings.ts';
import type { TranscriptionLog } from '../lib/stt/transcription-log.ts';
import { DEFAULT_VOICE_CLEANUP, type VoiceCleanup } from '../lib/stt/voice-cleanup.ts';
import { verifyWordOnly } from '../lib/stt/word-only-verifier.ts';
import { readUserMessage } from '../lib/user-message.ts';

/**
 * What the panel shows and what the push-to-talk shortcut reads.
 *
 * Owned here rather than by the recognition port: `transcribing` covers the
 * enhancement round trip this hook runs after the browser has settled its
 * words, which the port itself knows nothing about.
 */
export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'review' | 'error';

export interface DictationError {
  readonly code: string;
  readonly message: string;
}

export interface DictationDraftResult {
  /** The complete next draft value — not the transcript on its own. */
  readonly text: string;
  /** Where the caret should sit afterwards. */
  readonly caret: number;
}

/** A take that went in without being reviewed first: the draft as it was, and as it is now. */
export interface DictationAutoInsertion {
  readonly before: DictationDraftResult;
  readonly after: DictationDraftResult;
}

/**
 * A finished take waiting for the person's decision. `cleaned` equals `raw` when cleanup was off,
 * changed nothing, or failed (`enhancementError` then says why); the box offers the raw words
 * beside the cleaned ones only when they differ. `id` is new for every take, so UI state keyed on
 * it cannot leak from one take into the next.
 */
export interface DictationReview {
  readonly id: number;
  readonly raw: string;
  readonly cleaned: string;
  readonly enhancementError?: DictationError;
  /** The cleanup call's record in the debug ring, when dictation debug was on for this take. */
  readonly debugId?: string;
}

/** What a cleanup call leaves behind besides its text, for the debug ring and the transcription log. */
interface CleanupNotes {
  trace?: CleanupTrace;
  prompt?: VoiceCleanup['style'];
  /** What the call says about itself for the timeline; its wall time is the recorder's. */
  cleanup?: Omit<CleanupTiming, 'totalMs'>;
}

/** The timeline of the take now in review, kept so insertion can finish it. */
interface PendingTimeline {
  readonly timeline: DictationTimeline;
  readonly logId?: string;
  readonly debugId?: string;
  /** When the review opened, on the monotonic clock. */
  readonly readyAt: number;
}

const defaultMonotonic = (): number => globalThis.performance.now();

/**
 * How many events to ask for when mining vocabulary. Larger than the 5–10
 * messages actually used because most ledger records are tools or thinking.
 */
export const CONTEXT_FETCH_LIMIT = 60;
/** Context is a nicety and cannot become the slow part of Stop. */
export const CONTEXT_FETCH_TIMEOUT_MS = 250;
export const MIN_CONTEXT_MESSAGES = 5;
export const MAX_CONTEXT_MESSAGES = 10;

const CONTEXT_FETCH_TIMED_OUT = Symbol('context-fetch-timed-out');

/** Resolve `undefined` rather than waiting past the budget. */
export async function withinContextFetchBudget<T>(
  request: Promise<T>,
  timeoutMs = CONTEXT_FETCH_TIMEOUT_MS,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof CONTEXT_FETCH_TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(CONTEXT_FETCH_TIMED_OUT), Math.max(1, timeoutMs));
  });
  try {
    const result = await Promise.race([request, timeout]);
    return result === CONTEXT_FETCH_TIMED_OUT ? undefined : result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What a person's own record says: a peer message is its body, and Ferretry's plumbing (a delivery
 * notice, a pointer to a turn file) says nothing a person spoke, so it is not conversation.
 */
const spokenWords = (raw: string): string => {
  const message = readUserMessage(raw);
  if (message.kind === 'human') return message.text;
  return message.kind === 'peer' ? message.body : '';
};

interface ContextRecordLike {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** Last 5–10 user/assistant text messages, oldest first. */
export function extractContextMessages(records: readonly ContextRecordLike[] | undefined): string[] {
  if (!Array.isArray(records)) return [];
  const texts: string[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.type !== 'chat.user' && record.type !== 'chat.assistant.text') continue;
    const text = (record.data as { text?: unknown } | null | undefined)?.text;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const words = record.type === 'chat.user' ? spokenWords(text) : text;
    if (words.trim().length > 0) texts.push(words);
  }
  return texts.slice(-MAX_CONTEXT_MESSAGES);
}

/** A transcript row, as far as the conversation a clean-up reads is concerned. */
interface ConversationRowLike {
  readonly kind: string;
  readonly text: string;
  readonly handoff?: unknown;
}

/**
 * What was SAID in a transcript the page already holds: the person's messages and the agent's replies,
 * oldest first. Tool rows, notices and a hand-off pointer (whose text is plumbing, not words) are not.
 */
export function conversationFromTranscript(rows: readonly ConversationRowLike[]): string[] {
  return rows
    .filter(row => (row.kind === 'user' && row.handoff === undefined) || row.kind === 'assistant')
    .map(row => row.text);
}

/** The newest 10 non-empty messages of a conversation the page holds. */
export function extractHeldMessages(messages: readonly string[]): string[] {
  return messages.filter(message => message.trim().length > 0).slice(-MAX_CONTEXT_MESSAGES);
}

/** Sparse context is weaker evidence than the dictionary alone. */
export function hasUsableContext(messages: readonly string[]): boolean {
  return messages.length >= MIN_CONTEXT_MESSAGES;
}

/** Namespace remote correction failures away from recognition failures. */
export const enhancementErrorFrom = (failure: unknown): DictationError => {
  const code = (failure as { code?: unknown } | null)?.code;
  return {
    code: `enhancement-${typeof code === 'string' ? code : 'provider'}`,
    message:
      failure instanceof Error ? failure.message : 'Enhancement failed for an unknown reason; raw dictation was kept.',
  };
};

/** Said when neither this device nor the daemon holds a key for the chosen provider. */
export const noCleanupKeyMessage = (provider: string): string =>
  `Neither this device nor this machine has a ${provider} key: add a ${provider} key in ${DEVICE_KEYS_PLACE}.`;

export interface UseDictationOptions {
  /** Used only by optional context/Groq enhancement. Audio never reaches it. */
  readonly daemon: DaemonConnection;
  /** Used only to mine enhancement vocabulary. Dictation works without it. */
  readonly sessionId?: string;
  /** This daemon's own client, used only for that bounded vocabulary read. */
  readonly api?: Pick<IFyApiClient, 'history'>;
  /** Read at commit time so typing during recognition is preserved. */
  readonly draft: string;
  /** Without a live selection, recognised words append at the end. */
  readonly selectionRef?: { readonly current: SelectionLike | null };
  onDraft(result: DictationDraftResult): void;
  /**
   * Called right after `onDraft` when `settings.afterDictation` is `insert` put a take into the draft
   * without a review, so the host can offer one-step Undo. Never called for a reviewed Insert.
   */
  onAutoInserted?(insertion: DictationAutoInsertion): void;
  readonly settings: SttSettings;
  /** Browser recognition and visibility surface; injected by tests/harness. */
  readonly recognition?: BrowserRecognitionProvider;
  /**
   * Opens the meter-only microphone that browser speech needs for its level bars, since the browser
   * owns the real one. The page's own when omitted; `null` means no meter. Parakeet never uses it:
   * its meter taps the recording's own stream.
   */
  readonly meter?: MicMeterPort | null;
  /** Parakeet on this device. Read from the app store when omitted; `null` means not available here. */
  readonly parakeet?: ParakeetVoice | null;
  /** Every on-device model's voice. Read from the app store when omitted; `null` means none here. */
  readonly voices?: OnDeviceVoices | null;
  /** The machine's cleanup settings (voice.yaml); the defaults when absent. Only the hosted providers read them. */
  readonly voiceCleanup?: VoiceCleanup;
  /** Optional text-only correction transport through the paired daemon. */
  readonly enhancementFetch?: RemoteEnhancementFetch;
  /** Provider keys this device holds. Read from the app store when omitted; `null` means none here. */
  readonly speedupKeys?: DeviceSpeedupKeys | null;
  /** The dictation debug ring. Read from the app store when omitted; `null` means none here. */
  readonly dictationDebug?: DictationDebugLog | null;
  /** This device's transcription log. Read from the app store when omitted; `null` means none here. */
  readonly transcriptionLog?: TranscriptionLog | null;
  /** What the conversation is called, for the transcription log. */
  readonly sessionLabel?: string;
  /** Wall clock for the transcription log and debug timings; a suite supplies its own. */
  readonly now?: () => number;
  /** Monotonic clock (`performance.now`) for stage timings; a suite supplies a fake one. */
  readonly monotonic?: () => number;
  /**
   * The session's conversation as the page already holds it, oldest first. When given, clean-up reads
   * this instead of fetching history from the daemon.
   */
  readonly readConversation?: () => readonly string[];
  readonly disabled?: boolean;
}

export interface DictationHandle {
  /** False when recognition is unavailable here. The control still says so. */
  readonly supported: boolean;
  /** The engine this dictation uses, or `null` until the person has chosen one. */
  readonly engine: SttSettings['engine'];
  readonly phase: DictationPhase;
  readonly recording: boolean;
  /**
   * Everything heard so far — browser interim/final words, or Parakeet's near-live committed then
   * interim words. Read-only preview; never the output seam.
   */
  readonly liveText: string;
  /** The provisional tail of `liveText` (Parakeet near-live), shown greyed. Empty for browser voice. */
  readonly liveInterim: string;
  /** Parakeet near-live words stopped for this take: the device could not keep up. */
  readonly livePaused: boolean;
  /** The open microphone’s level tap while recording, for the input meter; `null` when there is none. */
  readonly inputMonitor: CaptureMonitor | null;
  readonly error: DictationError | null;
  /** The finished take awaiting Insert or Discard; `null` outside phase `review`. */
  readonly review: DictationReview | null;
  readonly busy: boolean;
  /** Call synchronously from the reader gesture. */
  start(): void;
  stop(): void;
  cancel(): void;
  dismissError(): void;
  /** Put `text` (the transcript as the person left it) into the draft at the caret, then clear the review. */
  insert(text: string): void;
  /** Drop the review; the draft is untouched. */
  discard(): void;
}

/** The preview state: the whole line, its provisional tail, and whether near-live words paused. */
interface LiveWords {
  readonly text: string;
  readonly interim: string;
  readonly paused: boolean;
}

const NO_LIVE_WORDS: LiveWords = Object.freeze({ text: '', interim: '', paused: false });

/** Near-live committed + interim words → the preview line and its greyed tail. */
export const liveWordsFrom = (state: NearLiveState): LiveWords => ({
  text: joinWords(state.committed, state.interim),
  interim: state.interim.trim(),
  paused: state.paused,
});

export function useDictation(options: UseDictationOptions): DictationHandle {
  const disabled = Boolean(options.disabled || !options.settings.enabled);
  const ambientRecognition = useMemo(() => browserRecognitionProvider(), []);
  const recognition = options.recognition ?? ambientRecognition;
  const contextVoice = useParakeetVoice();
  const contextVoices = useOnDeviceVoices();
  const voices = options.voices === undefined ? contextVoices : options.voices;
  const contextKeys = useSpeedupKeys();
  const speedupKeysRef = useRef<DeviceSpeedupKeys | null>(null);
  speedupKeysRef.current = options.speedupKeys === undefined ? contextKeys : options.speedupKeys;
  const contextDebug = useDictationDebug();
  const dictationDebugRef = useRef<DictationDebugLog | null>(null);
  dictationDebugRef.current = options.dictationDebug === undefined ? contextDebug : options.dictationDebug;
  const contextLog = useTranscriptionLog();
  const transcriptionLogRef = useRef<TranscriptionLog | null>(null);
  transcriptionLogRef.current = options.transcriptionLog === undefined ? contextLog : options.transcriptionLog;
  const engine = options.settings.engine;
  const voice: OnDeviceVoice | null = !isOnDeviceEngine(engine)
    ? null
    : engine === 'parakeet' && options.parakeet !== undefined
      ? options.parakeet
      : (voices?.get(engine) ?? (engine === 'parakeet' ? contextVoice : null));
  // Unchosen counts as supported: the mic stays live so pressing it can ask the person to choose.
  const supported = isOnDeviceEngine(engine)
    ? voice?.support.available === true
    : engine === 'browser'
      ? recognition.support.available
      : true;
  const ambientMeter = useMemo(() => browserMicMeter(globalThis as unknown as MicMeterGlobalLike), []);
  const meterPort = options.meter === undefined ? ambientMeter : options.meter;
  const meterPortRef = useRef(meterPort);
  meterPortRef.current = meterPort;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<DictationError | null>(null);
  const [review, setReview] = useState<DictationReview | null>(null);
  const reviewIdRef = useRef(0);
  /** The transcription-log entry for the take now in review, until it is inserted or discarded. */
  const logEntryRef = useRef<{ readonly id: string; readonly cleaned: string } | null>(null);
  const pendingTimelineRef = useRef<PendingTimeline | null>(null);
  /** When the take being recorded began, by generation, so a restarting mobile engine cannot move it. */
  const takeStartRef = useRef<{ readonly token: number; readonly at: number } | null>(null);
  const [live, setLive] = useState<LiveWords>(NO_LIVE_WORDS);
  const [inputMonitor, setInputMonitor] = useState<CaptureMonitor | null>(null);
  const meterRef = useRef<MicMeter | null>(null);
  /** The take whose meter is open or opening: a mobile engine restarts and reports `start` again. */
  const meterTakeRef = useRef(-1);

  // Refs, not state: recognition and enhancement continuations outlive the
  // render that started them.
  const generationRef = useRef(0);
  const liveSessionRef = useRef<BrowserRecognitionSessionLike | null>(null);
  const finishingSessionRef = useRef<BrowserRecognitionSessionLike | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  const recognitionRef = useRef(recognition);
  optionsRef.current = options;
  // The correction is a daemon request, so it travels the carrier router unless a caller hands in its
  // own. It used to fall back to the plain network, which on a relay-only daemon turned every remote
  // correction into "could not be reached".
  const routedFetch = useDaemonFetch();
  const routedFetchRef = useRef(routedFetch);
  routedFetchRef.current = routedFetch;
  recognitionRef.current = recognition;

  const isCurrent = useCallback((token: number): boolean => generationRef.current === token, []);

  /** Settle the take in review in the transcription log: what became of its words. */
  const settleLog = useCallback(
    (
      outcome: 'inserted' | 'discarded',
      inserted?: string,
      insertion?: { insertMs: number; reviewMs: number },
    ): void => {
      const entry = logEntryRef.current;
      const pending = pendingTimelineRef.current;
      logEntryRef.current = null;
      pendingTimelineRef.current = null;
      const timeline =
        pending === null || insertion === undefined ? undefined : withInsertion(pending.timeline, insertion);
      if (pending?.debugId !== undefined && timeline !== undefined) {
        dictationDebugRef.current?.annotate(pending.debugId, timeline);
      }
      if (entry === null) return;
      const changed = inserted !== undefined && inserted.trim() !== entry.cleaned;
      transcriptionLogRef.current?.update(entry.id, {
        outcome,
        ...(changed ? { inserted: inserted.trim() } : {}),
        ...(timeline === undefined ? {} : { timeline }),
      });
    },
    [],
  );

  /** Close the meter-only microphone, if one is open, and drop the tap. */
  const releaseMeter = useCallback((): void => {
    const meter = meterRef.current;
    meterRef.current = null;
    meter?.release();
    setInputMonitor(null);
  }, []);

  /** Cancel every owner and return the next generation token. */
  const invalidate = useCallback((): number => {
    generationRef.current += 1;
    releaseMeter();
    const live = liveSessionRef.current;
    const finishing = finishingSessionRef.current;
    liveSessionRef.current = null;
    finishingSessionRef.current = null;
    try {
      live?.cancel();
    } catch {
      // Already ended.
    }
    if (finishing !== live) {
      try {
        finishing?.cancel();
      } catch {
        // Already ended.
      }
    }
    controllerRef.current?.abort();
    controllerRef.current = null;
    return generationRef.current;
  }, [releaseMeter]);

  // Unmount releases the browser microphone and suppresses every continuation.
  useEffect(() => () => void invalidate(), [invalidate]);

  useEffect(() => {
    if (!disabled) return;
    invalidate();
    settleLog('discarded');
    setLive(NO_LIVE_WORDS);
    setError(null);
    setReview(null);
    setPhase('idle');
  }, [disabled, invalidate, settleLog]);

  const commit = useCallback((transcript: string): DictationAutoInsertion | null => {
    const spoken = transcript.trim();
    if (spoken.length === 0) return null;
    const current = optionsRef.current;
    const [start, end] = readSelection(current.selectionRef?.current, current.draft);
    const result = insertTranscript(current.draft, start, end, spoken);
    // THE ONLY OUTPUT.
    current.onDraft(result);
    return { before: { text: current.draft, caret: start }, after: result };
  }, []);

  /** Put the take's text in the draft and settle the log: what Insert does, whoever pressed it. */
  const commitTake = useCallback(
    (text: string): DictationAutoInsertion | null => {
      const monotonic = optionsRef.current.monotonic ?? defaultMonotonic;
      const began = monotonic();
      const insertion = commit(text);
      const insertMs = monotonic() - began;
      const readyAt = pendingTimelineRef.current?.readyAt ?? began;
      settleLog('inserted', text, { insertMs, reviewMs: began - readyAt });
      setReview(null);
      setPhase('idle');
      return insertion;
    },
    [commit, settleLog],
  );

  /**
   * Recent conversation for the enhancer, or nothing. Never an error. On-device correction mines
   * vocabulary and wants enough messages to be evidence; a hosted model only spells names from it.
   */
  const readContext = useCallback(async (needsEvidence: boolean): Promise<string[]> => {
    const current = optionsRef.current;
    if (current.readConversation !== undefined) {
      const held = extractHeldMessages(current.readConversation());
      return !needsEvidence || hasUsableContext(held) ? held : [];
    }
    if (current.sessionId === undefined || current.api === undefined) return [];
    try {
      const events = await withinContextFetchBudget(
        current.api.history(current.sessionId, undefined, CONTEXT_FETCH_LIMIT),
      );
      const recent = extractContextMessages(events);
      return !needsEvidence || hasUsableContext(recent) ? recent : [];
    } catch {
      return [];
    }
  }, []);

  /** Correct the raw words or return them untouched. */
  const enhanceTranscript = useCallback(
    async (
      raw: string,
      token: number,
      onFailure: (failure: DictationError) => void,
      notes: CleanupNotes,
      timeline: DictationTimelineRecorder,
    ): Promise<string> => {
      const current = optionsRef.current;
      const active = current.settings;
      if (!active.enhancement) return raw;
      const { entries } = sttDictionary(active);
      const cleanup = current.voiceCleanup ?? DEFAULT_VOICE_CLEANUP;
      const remote = isRemoteEnhancementProvider(active.enhancementProvider);
      // Cleanup switched off on the machine: nothing is sent, nothing is spent.
      if (remote && cleanup.style === 'off') return raw;
      // A hosted provider sees the conversation only when the machine says so, and only the latest messages.
      let context: string[] = [];
      if (!remote || cleanup.useConversation) {
        context = await timeline.measure('context', async () =>
          remote ? (await readContext(false)).slice(-cleanup.conversationMessages) : await readContext(true),
        );
      }
      if (!isCurrent(token)) return raw;

      if (isRemoteEnhancementProvider(active.enhancementProvider)) {
        const provider = active.enhancementProvider;
        const debug = dictationDebugRef.current?.snapshot().enabled === true;
        notes.prompt = cleanup.style;
        const route = { via: 'device' as 'device' | 'daemon' };
        try {
          const signal = controllerRef.current?.signal;
          const keys = speedupKeysRef.current;
          const result = await timeline.measure('cleanup', async () => {
            // This device's own key first: straight to the provider, no daemon round trip.
            const direct: RemoteEnhancementResult | undefined =
              keys === null
                ? undefined
                : await requestDeviceCleanup(keys, {
                    provider,
                    model: active.enhancementModel,
                    text: raw,
                    dictionary: entries,
                    context,
                    userContext: active.userContext,
                    cleanup,
                    ...(current.monotonic ? { monotonic: current.monotonic } : {}),
                    ...(debug ? { debug } : {}),
                    ...(signal ? { signal } : {}),
                  });
            if (direct !== undefined) return direct;
            route.via = 'daemon';
            return await requestRemoteEnhancement(current.daemon, {
              provider,
              model: active.enhancementModel,
              text: raw,
              dictionary: entries,
              context,
              userContext: active.userContext,
              ...(debug ? { debug } : {}),
              ...(signal ? { signal } : {}),
              fetchImpl: current.enhancementFetch ?? routedFetchRef.current,
            });
          });
          notes.trace = result.trace;
          notes.cleanup = cleanupDetailsOf({
            provider,
            model: result.model ?? active.enhancementModel,
            via: route.via,
            outcome: result.kept === 'raw' ? 'kept_raw' : 'cleaned',
            device: result.timing,
            providerMs: result.latencyMs,
            trace: result.trace,
          });
          if (result.kept === 'raw') {
            // The daemon refused the model's reply and sent the words back: say why instead of looking like a no-op.
            onFailure({
              code: 'enhancement-kept-raw',
              message: `${result.keptReason ?? 'The cleanup reply did not read as your words corrected.'}`,
            });
          }
          return result.text;
        } catch (failure) {
          if (!isCurrent(token) || controllerRef.current?.signal.aborted === true) return raw;
          const failed = failure as Partial<RemoteEnhancementError> | null;
          notes.trace = failed?.trace;
          notes.cleanup = cleanupDetailsOf({
            provider,
            model: active.enhancementModel,
            via: route.via,
            outcome: 'failed',
            device: failed?.timing,
            trace: failed?.trace,
          });
          const notConfigured = (failure as { code?: unknown } | null)?.code === 'not-configured';
          onFailure(
            notConfigured
              ? { code: 'enhancement-not-configured', message: noCleanupKeyMessage(CLEANUP_PROVIDERS[provider].label) }
              : enhancementErrorFrom(failure),
          );
          return raw;
        }
      }

      return timeline.measureSync('cleanup', () => {
        const candidate = enhance({ text: raw, dictionary: entries, context, userContext: active.userContext });
        // Enhancement can improve recognition, never cost the original words.
        const kept = candidate.text !== raw && verifyWordOnly(raw, candidate.text).ok ? candidate.text : raw;
        notes.cleanup = cleanupDetailsOf({
          provider: 'local',
          via: 'local',
          outcome: kept === raw ? 'kept_raw' : 'cleaned',
        });
        return kept;
      });
    },
    [isCurrent, readContext],
  );

  /** Claim and finish this generation exactly once. */
  const finish = useCallback(
    async (token: number, session: BrowserRecognitionSessionLike): Promise<void> => {
      if (!isCurrent(token) || liveSessionRef.current !== session) return;
      liveSessionRef.current = null;
      finishingSessionRef.current = session;
      releaseMeter();
      setPhase('transcribing');
      const stoppedAt = (optionsRef.current.now ?? Date.now)();
      const take = takeStartRef.current?.token === token ? takeStartRef.current : null;
      const monotonic = optionsRef.current.monotonic ?? defaultMonotonic;
      const timeline = new DictationTimelineRecorder(monotonic);

      let enhancementFailure: DictationError | null = null;
      try {
        const raw = await timeline.measure('speech', () => session.finish());
        if (!isCurrent(token)) return;
        if (raw.trim().length === 0) {
          setLive(NO_LIVE_WORDS);
          setPhase('idle');
          return;
        }

        controllerRef.current = new AbortController();
        const notes: CleanupNotes = {};
        const text = await enhanceTranscript(
          raw,
          token,
          failure => {
            enhancementFailure = failure;
          },
          notes,
          timeline,
        );
        if (!isCurrent(token)) return;
        reviewIdRef.current += 1;
        const current = optionsRef.current;
        const clock = current.now ?? Date.now;
        const built = timeline.build({
          engine: isOnDeviceEngine(engine) ? engine : 'web-speech',
          provider: isOnDeviceEngine(engine) ? 'on-device' : 'browser',
          ...(session.timings?.() === undefined ? {} : { session: session.timings() }),
          ...(take === null ? {} : { audioMs: Math.max(0, stoppedAt - take.at) }),
          ...(notes.cleanup === undefined ? {} : { cleanup: notes.cleanup }),
        });
        const debugId =
          notes.trace === undefined
            ? undefined
            : dictationDebugRef.current?.record(notes.trace, notes.trace.startedAt ?? clock(), built);
        const cleaned = text.trim();
        const changed = cleaned !== raw.trim();
        const logged = transcriptionLogRef.current?.add({
          at: stoppedAt,
          ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId }),
          ...(current.sessionLabel === undefined ? {} : { sessionLabel: current.sessionLabel }),
          engine: isOnDeviceEngine(engine) ? engine : 'web-speech',
          ...(take === null ? {} : { durationMs: Math.max(0, stoppedAt - take.at) }),
          raw: raw.trim(),
          ...(changed ? { cleaned } : {}),
          ...(notes.prompt === undefined || notes.prompt === 'off' ? {} : { prompt: notes.prompt }),
          outcome: 'pending',
          ...(debugId === undefined ? {} : { debugId }),
          timeline: built,
        });
        logEntryRef.current = logged === undefined ? null : { id: logged, cleaned: changed ? cleaned : raw.trim() };
        pendingTimelineRef.current = {
          timeline: built,
          ...(logged === undefined ? {} : { logId: logged }),
          ...(debugId === undefined ? {} : { debugId }),
          readyAt: monotonic(),
        };
        setLive(NO_LIVE_WORDS);
        // Only a clean, non-empty take goes in unseen; a cleanup failure or an empty result is parked
        // for review so its reason is read and no words are lost.
        if (current.settings.afterDictation === 'insert' && enhancementFailure === null && cleaned.length > 0) {
          const insertion = commitTake(cleaned);
          if (insertion !== null) optionsRef.current.onAutoInserted?.(insertion);
          return;
        }
        setReview({
          id: reviewIdRef.current,
          raw: raw.trim(),
          cleaned,
          ...(enhancementFailure === null ? {} : { enhancementError: enhancementFailure }),
          ...(debugId === undefined ? {} : { debugId }),
        });
        setPhase('review');
      } catch (failure) {
        if (!isCurrent(token)) return;
        const recognitionFailure = browserRecognitionErrorFrom(failure);
        if (recognitionFailure.code === 'aborted') {
          setLive(NO_LIVE_WORDS);
          // The recognition session also reports its terminal error through
          // `onFailure` before rejecting `finish()`. Cancellation is not a
          // failed take, so clear that earlier write as part of the same
          // transition back to idle.
          setError(null);
          setPhase('idle');
        } else {
          setError({ code: recognitionFailure.code, message: recognitionFailure.message });
          setPhase('error');
        }
      } finally {
        if (finishingSessionRef.current === session) finishingSessionRef.current = null;
        if (isCurrent(token)) controllerRef.current = null;
      }
    },
    [commitTake, enhanceTranscript, engine, isCurrent, releaseMeter],
  );

  const start = useCallback(() => {
    if (disabled || phase === 'requesting' || phase === 'recording') return;

    const provider = recognitionRef.current;
    const token = invalidate();
    settleLog('discarded');
    setLive(NO_LIVE_WORDS);
    setError(null);
    setReview(null);
    setPhase('requesting');

    if (engine === null) {
      setError({
        code: 'engine-not-chosen',
        message:
          'Choose how to dictate first, in Settings › Voice: Parakeet on this device (private, a one-time download) or phone/browser voice (no download; audio goes to your browser’s maker).',
      });
      setPhase('error');
      return;
    }

    if (engine === 'browser' && !provider.support.available) {
      setError({
        code: 'recognition-unavailable',
        message: provider.support.reason ?? 'Dictation is unavailable in this browser.',
      });
      setPhase('error');
      return;
    }

    let session: (BrowserRecognitionSessionLike & { start(): void }) | null = null;
    try {
      const callbacks: BrowserRecognitionSessionOptions = {
        onStart: () => {
          if (!isCurrent(token)) return;
          if (takeStartRef.current?.token !== token) {
            takeStartRef.current = { token, at: (optionsRef.current.now ?? Date.now)() };
          }
          setPhase('recording');
          const port = meterPortRef.current;
          if (engine !== 'browser' || port === null || meterTakeRef.current === token) return;
          meterTakeRef.current = token;
          // Browser speech owns its microphone, so the meter listens through one of its own. It
          // can only ever fail quietly: bars are a visual aid and must never end a dictation.
          void port.open().then(
            meter => {
              if (meter === null) return;
              if (!isCurrent(token) || liveSessionRef.current !== session) {
                meter.release();
                return;
              }
              meterRef.current = meter;
              setInputMonitor(meter.monitor);
            },
            () => undefined,
          );
        },
        onMonitor: monitor => {
          if (isCurrent(token)) setInputMonitor(monitor);
        },
        onTranscript: text => {
          if (isCurrent(token)) setLive({ text, interim: '', paused: false });
        },
        onFailure: failure => {
          if (!isCurrent(token)) return;
          if (liveSessionRef.current === session) liveSessionRef.current = null;
          releaseMeter();
          // A cancellation is not a failed take, WHENEVER it arrives. The
          // engine can report `aborted` while recognition is still open — a
          // second recognizer taking the microphone, or the browser abandoning
          // the session — and that has to land where a reader-initiated cancel
          // lands: idle, no error, nothing to dismiss. The `finish()` catch
          // below already does this for the abort that arrives after Stop;
          // without the same rule here the two identical situations differed
          // only by timing, and the earlier one showed a generic "Dictation
          // failed" for a take nobody failed. This coupling is also why
          // `dictationFailureCopy` deliberately has no `aborted` case.
          if (failure.code === 'aborted') {
            setLive(NO_LIVE_WORDS);
            setError(null);
            setPhase('idle');
            return;
          }
          setError({ code: failure.code, message: failure.message });
          setPhase('error');
        },
        onAbort: () => {
          if (!isCurrent(token)) return;
          invalidate();
          setLive(NO_LIVE_WORDS);
          setError(null);
          setReview(null);
          setPhase('idle');
        },
        onLimit: () => {
          if (session !== null) void finish(token, session);
        },
      };
      if (isOnDeviceEngine(engine)) {
        const onDevice = voiceRef.current;
        if (onDevice === null)
          throw new BrowserRecognitionError(
            'recognition-unavailable',
            `${onDeviceModel(engine)?.shortName ?? 'This engine'} is not available in this copy of Ferretry.`,
          );
        session = onDevice.createSession({
          ...callbacks,
          liveWords: optionsRef.current.settings.liveWordsOptIn,
          onLive: state => {
            if (isCurrent(token)) setLive(liveWordsFrom(state));
          },
        });
      } else session = new BrowserRecognitionSession(provider, callbacks);
      liveSessionRef.current = session;
      // NO await above this call: permission stays attributable to the gesture.
      session.start();
    } catch (failure) {
      if (!isCurrent(token)) return;
      if (liveSessionRef.current === session) liveSessionRef.current = null;
      const recognitionFailure = browserRecognitionErrorFrom(failure);
      setError({ code: recognitionFailure.code, message: recognitionFailure.message });
      setPhase('error');
    }
  }, [disabled, engine, finish, invalidate, isCurrent, phase, releaseMeter, settleLog]);

  const stop = useCallback(() => {
    const session = liveSessionRef.current;
    if (session === null || (phase !== 'recording' && phase !== 'requesting')) return;
    void finish(generationRef.current, session);
  }, [finish, phase]);

  const cancel = useCallback(() => {
    invalidate();
    settleLog('discarded');
    setLive(NO_LIVE_WORDS);
    setError(null);
    setReview(null);
    setPhase('idle');
  }, [invalidate, settleLog]);

  const insert = useCallback(
    (text: string) => {
      if (phase !== 'review') return;
      commitTake(text);
    },
    [commitTake, phase],
  );

  const dismissError = useCallback(() => {
    setError(null);
    setPhase(current => (current === 'error' ? 'idle' : current));
  }, []);

  return {
    supported,
    engine,
    phase,
    recording: phase === 'recording',
    liveText: live.text,
    liveInterim: live.interim,
    livePaused: live.paused,
    inputMonitor,
    busy: phase === 'transcribing',
    error,
    review,
    start,
    stop,
    cancel,
    dismissError,
    insert,
    discard: cancel,
  };
}
