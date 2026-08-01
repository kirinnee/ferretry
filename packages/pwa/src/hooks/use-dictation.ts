/**
 * The dictation controller: one microphone, one transcript, and exactly one way
 * for text to leave it.
 *
 * There is no `onSubmit`, no `onSend`, and no path anywhere in this file from
 * model output to a message being sent. `onDraft` is called once, after the
 * recording is finished and enhancement has run, with the COMPLETE next draft
 * and where the caret should sit.
 *
 * TAP CONTROL. `start()` is called synchronously from the mic button so the
 * permission prompt is attributable to that gesture; `stop()` is the panel's
 * separate Stop action. A stop that arrives while permission is still pending is
 * remembered rather than ignored: when the stream finally opens it is finished
 * immediately, instead of turning on a recording nobody asked for.
 *
 * EVERY ASYNC BOUNDARY CHECKS THE GENERATION. `UtteranceLatch` owns the one live
 * capture and the generation counter, so a 120-second limit and a pointer
 * release cannot both finish the same utterance, and a backgrounded recording
 * can publish nothing afterwards. Those races have their own tests in
 * `lib/stt/utterance.ts`; this hook is the React shell around them.
 *
 * WHAT CHANGED FROM kteam (`ui/src/hooks/useDictation.ts`).
 *
 *   1. IT IS DAEMON-BOUND. kteam reached for a module-level `api` singleton and
 *      a module-level settings store, so one daemon's history could season
 *      another daemon's transcript and a paired-daemon switch changed nothing.
 *      Here the connection, the API client, the settings and the capture host
 *      are all parameters. `daemonTranscribe` additionally refuses a session
 *      scope belonging to a different daemon, so a stale session id cannot post
 *      audio to the wrong box.
 *   2. THE ENGINE IS A PORT, AND THE SHIPPED ONE IS THE DAEMON. kteam ran
 *      browser-local Parakeet through `lib/stt/local-engine.ts` and a rolling
 *      `LocalAgreementTranscriber` preview. Neither is ported (they need
 *      `onnxruntime-web`, a ~25 MB WASM asset and a bundler — PR #126). So there
 *      is no live preview and no `pendingSegments`; `DictationEngine` is the
 *      seam a browser-local engine drops into, and `daemonDictationEngine` is
 *      what ships today.
 *   3. THE FINISH IS THE TESTED LIFECYCLE. `finishUtterance` already owns claim,
 *      flush, too-short rejection, transcribe, refine and commit, so this hook
 *      composes it rather than repeating it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IFyApiClient } from '@ferretry/protocol';
import type { CaptureMonitor } from '../components/input-waveform.tsx';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionScope, type DaemonSessionScope } from '../lib/daemon-scope.ts';
import { startCapture, type CaptureHost, type CaptureSession } from '../lib/stt/audio-capture.ts';
import { captureErrorFrom } from '../lib/stt/capture-error.ts';
import { daemonTranscribe, type FetchLike } from '../lib/stt/daemon-engine.ts';
import { insertTranscript, readSelection, type SelectionLike } from '../lib/stt/draft.ts';
import { enhance } from '../lib/stt/enhancement.ts';
import { requestRemoteEnhancement, type RemoteEnhancementFetch } from '../lib/stt/remote-enhancement.ts';
import { sttDictionary, type SttSettings } from '../lib/stt/stt-settings.ts';
import { finishUtterance, UtteranceLatch, type DictationPhase } from '../lib/stt/utterance.ts';
import { verifyWordOnly } from '../lib/stt/word-only-verifier.ts';

export type { DictationPhase };

export interface DictationError {
  readonly code: string;
  readonly message: string;
}

export interface DictationDraftResult {
  /** The complete next draft value — not the transcript on its own. */
  readonly text: string;
  /** Where the caret should sit afterwards. */
  readonly caret: number;
  /**
   * A non-fatal post-transcription failure. `text` already contains the raw
   * words; the panel stays open only to show the real provider reason.
   */
  readonly enhancementError?: DictationError;
}

/**
 * How an utterance becomes words. One method, so a browser-local engine can
 * replace the daemon without this hook learning anything about either.
 */
export interface DictationEngine {
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>;
}

/**
 * How many events to ask for when mining vocabulary. Larger than the 5–10
 * messages actually used, because a session ledger is full of tool calls and
 * thinking blocks and only a fraction of any window is user or assistant text.
 */
export const CONTEXT_FETCH_LIMIT = 60;
/**
 * Context improves correction but must never become the slow part of stop. The
 * daemon is usually on the same machine, so a quarter second is enough for a
 * healthy answer; after that enhancement continues with the dictionary alone.
 */
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

/** The shape this hook reads off a ledger event. Structural, so it needs no schema. */
interface ContextRecordLike {
  readonly type?: unknown;
  readonly data?: unknown;
}

/**
 * The last 5–10 user and assistant TEXT messages, oldest first.
 *
 * Tool calls, tool results, thinking and reasoning are excluded on purpose:
 * they are full of paths, JSON and identifiers that would flood the fuzzy
 * vocabulary with near-misses for ordinary words.
 */
export function extractContextMessages(records: readonly ContextRecordLike[] | undefined): string[] {
  if (!Array.isArray(records)) return [];
  const texts: string[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.type !== 'chat.user' && record.type !== 'chat.assistant.text') continue;
    const text = (record.data as { text?: unknown } | null | undefined)?.text;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    texts.push(text);
  }
  return texts.slice(-MAX_CONTEXT_MESSAGES);
}

/**
 * True when there is enough recent conversation to be worth mining. Below the
 * floor the enhancer still runs — the dictionary alone is useful — it simply has
 * no conversational vocabulary to work with. Mining two messages would build a
 * fuzzy vocabulary out of whatever happened to be said first, which is exactly
 * the sparse-evidence guess this feature abstains from everywhere else.
 */
export function hasUsableContext(messages: readonly string[]): boolean {
  return messages.length >= MIN_CONTEXT_MESSAGES;
}

/** Codes carried by a `RemoteEnhancementError`, namespaced so the panel can tell them apart. */
export const enhancementErrorFrom = (failure: unknown): DictationError => {
  const code = (failure as { code?: unknown } | null)?.code;
  return {
    code: `enhancement-${typeof code === 'string' ? code : 'provider'}`,
    message:
      failure instanceof Error ? failure.message : 'Enhancement failed for an unknown reason; raw dictation was kept.',
  };
};

/**
 * The shipped engine: post the utterance to ONE paired daemon.
 *
 * The scope is passed through so `daemonTranscribe` can refuse a session that
 * belongs to a different daemon rather than silently posting here.
 */
export const daemonDictationEngine = (
  daemon: DaemonConnection,
  scope?: DaemonSessionScope,
  fetchImpl?: FetchLike,
): DictationEngine => ({
  transcribe: async (samples, signal) => {
    const transcript = await daemonTranscribe(daemon, {
      samples,
      signal,
      ...(scope ? { scope } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    return transcript.text;
  },
});

export interface UseDictationOptions {
  /** The paired daemon this dictation belongs to. Nothing here is ambient. */
  readonly daemon: DaemonConnection;
  /** Used only to mine enhancement vocabulary. Dictation works without it. */
  readonly sessionId?: string;
  /**
   * This daemon's own client. Supplied by the host for the same reason the
   * composer's is: there is no bundled origin, token or singleton daemon.
   */
  readonly api?: Pick<IFyApiClient, 'history'>;
  /**
   * The current draft, read at COMMIT time rather than captured at start, so
   * text typed during the utterance is not thrown away.
   */
  readonly draft: string;
  /**
   * The live textarea, for the caret. Optional: without it the transcript is
   * appended at the end, which is the right fallback rather than an error.
   */
  readonly selectionRef?: { readonly current: SelectionLike | null };
  onDraft(result: DictationDraftResult): void;
  /** The reader's device-lifetime dictation settings. */
  readonly settings: SttSettings;
  /**
   * The microphone. `null` means this browser has no microphone API at all, in
   * which case the control is HIDDEN rather than disabled: the capability is
   * absent (an insecure context), not refused, and a disabled button would imply
   * "not right now".
   */
  readonly captureHost: CaptureHost | null;
  /** Defaults to the daemon engine bound to `daemon` and this session's scope. */
  readonly engine?: DictationEngine;
  /**
   * The transport used for remote (Groq) enhancement, which goes to this same
   * daemon. Defaults to the browser's `fetch`; injected by tests so no suite
   * reaches the network, exactly as every other module under `lib/stt` allows.
   */
  readonly enhancementFetch?: RemoteEnhancementFetch;
  readonly disabled?: boolean;
}

export interface DictationHandle {
  /** False when this browser cannot record at all. Render nothing. */
  readonly supported: boolean;
  readonly phase: DictationPhase;
  /** True while the microphone is actually open. Drives `aria-pressed`. */
  readonly recording: boolean;
  /** A read-only analyser factory over the recorder's own audio graph. */
  readonly inputMonitor: CaptureMonitor | null;
  readonly error: DictationError | null;
  /** True while a transcript is being produced, for the status line. */
  readonly busy: boolean;
  /** Call SYNCHRONOUSLY from a pointerdown or keydown handler. */
  start(): void;
  /** Call from pointerup or keyup. Safe at any phase. */
  stop(): void;
  /** Throw away whatever is in flight. Safe at any phase. */
  cancel(): void;
  dismissError(): void;
}

export function useDictation(options: UseDictationOptions): DictationHandle {
  const { daemon, sessionId, settings, captureHost } = options;
  const disabled = Boolean(options.disabled || !settings.enabled);
  const supported = captureHost !== null;

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<DictationError | null>(null);
  // One transition when capture opens and one when it closes. The waveform
  // itself never updates React state; it paints its canvas behind a ref.
  const [inputMonitor, setInputMonitor] = useState<CaptureMonitor | null>(null);

  // Refs, not state, for everything the async paths read: state would be a stale
  // closure by the time a transcription or a history lookup resolves.
  const latchRef = useRef<UtteranceLatch | null>(null);
  latchRef.current ??= new UtteranceLatch();
  const latch = latchRef.current;

  const releaseRequested = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const scope = useMemo(
    () => (sessionId === undefined || sessionId === '' ? undefined : daemonSessionScope(daemon, sessionId)),
    [daemon, sessionId],
  );
  const defaultEngine = useMemo(() => daemonDictationEngine(daemon, scope), [daemon, scope]);
  const engine = options.engine ?? defaultEngine;
  const engineRef = useRef(engine);
  engineRef.current = engine;

  /**
   * Drop the current utterance entirely. Invalidating the generation first is
   * what suppresses any continuation already in flight — important during
   * unmount, where even a harmless setState is teardown work React should never
   * receive.
   */
  const teardown = useCallback(() => {
    latch.cancel();
    controllerRef.current?.abort();
    controllerRef.current = null;
    releaseRequested.current = false;
  }, [latch]);

  // Unmount and disable must both release the microphone. A recording indicator
  // that outlives the component is the fastest way to lose a reader's trust.
  useEffect(() => () => teardown(), [teardown]);

  useEffect(() => {
    if (!disabled) return;
    // kteam also released ~1 GB of resident ONNX sessions here. There is no
    // browser-local engine to unload in this build, so turning dictation off is
    // exactly "close the microphone and forget the utterance".
    teardown();
    setInputMonitor(null);
    setError(null);
    setPhase('idle');
  }, [disabled, teardown]);

  const commit = useCallback((transcript: string, enhancementError?: DictationError) => {
    const spoken = transcript.trim();
    if (spoken.length === 0) return;
    const current = optionsRef.current;
    const [start, end] = readSelection(current.selectionRef?.current, current.draft);
    const result = insertTranscript(current.draft, start, end, spoken);
    // THE ONLY OUTPUT.
    current.onDraft({ ...result, ...(enhancementError ? { enhancementError } : {}) });
  }, []);

  /** Recent conversation for the enhancer, or nothing at all. Never an error. */
  const readContext = useCallback(async (): Promise<string[]> => {
    const current = optionsRef.current;
    if (current.sessionId === undefined || current.api === undefined) return [];
    try {
      const events = await withinContextFetchBudget(
        current.api.history(current.sessionId, undefined, CONTEXT_FETCH_LIMIT),
      );
      const recent = extractContextMessages(events);
      return hasUsableContext(recent) ? recent : [];
    } catch {
      // Enhancement context is a nicety. A failed history read must never cost
      // the reader their transcript, so it degrades to the dictionary alone
      // rather than surfacing an error.
      return [];
    }
  }, []);

  /**
   * Correct the raw words, or return them untouched.
   *
   * Records a non-fatal provider failure in `enhancementFailure` instead of
   * throwing: the raw transcript is still going into the draft, and the panel
   * shows the real reason afterwards.
   */
  const enhanceTranscript = useCallback(
    async (raw: string, token: number, onFailure: (failure: DictationError) => void): Promise<string> => {
      const current = optionsRef.current;
      const active = current.settings;
      if (!active.enhancement) return raw;
      const { entries } = sttDictionary(active);
      const context = await readContext();
      if (!latch.isCurrent(token)) return raw;

      if (active.enhancementProvider === 'groq') {
        try {
          const signal = controllerRef.current?.signal;
          const result = await requestRemoteEnhancement(current.daemon, {
            provider: 'groq',
            model: active.enhancementModel,
            text: raw,
            dictionary: entries,
            context,
            userContext: active.userContext,
            ...(signal ? { signal } : {}),
            ...(current.enhancementFetch ? { fetchImpl: current.enhancementFetch } : {}),
          });
          return result.text;
        } catch (failure) {
          if (!latch.isCurrent(token) || controllerRef.current?.signal.aborted === true) return raw;
          onFailure(enhancementErrorFrom(failure));
          return raw;
        }
      }

      const candidate = enhance({ text: raw, dictionary: entries, context, userContext: active.userContext });
      if (candidate.text === raw) return raw;
      // THE VERIFIER IS NOT OPTIONAL AND NOT ADVISORY. If it refuses — for any
      // reason — the reader gets the engine's own words, unmodified. Enhancement
      // can improve a transcript; it can never cost one.
      return verifyWordOnly(raw, candidate.text).ok ? candidate.text : raw;
    },
    [latch, readContext],
  );

  /**
   * Claim and finish this generation exactly once. `finishUtterance` owns the
   * claim, the flush, the too-short rejection and the ordering; this supplies
   * the ports and then reports an enhancement failure the lifecycle has no
   * vocabulary for.
   */
  const finish = useCallback(
    async (token: number): Promise<void> => {
      let enhancementFailure: DictationError | null = null;
      setInputMonitor(null);
      await finishUtterance(token, {
        latch,
        transcribe: (samples, signal) => engineRef.current.transcribe(samples, signal),
        refine: raw =>
          enhanceTranscript(raw, token, failure => {
            enhancementFailure = failure;
          }),
        commit: text => commit(text, enhancementFailure ?? undefined),
        setPhase,
        setError,
        onController: controller => {
          controllerRef.current = controller;
        },
      });
      // `finishUtterance` has no notion of "it worked, but the correction did
      // not", so the panel is told here — after the raw words have landed.
      if (enhancementFailure !== null && latch.isCurrent(token)) {
        setError(enhancementFailure);
        setPhase('error');
      }
    },
    [commit, enhanceTranscript, latch],
  );

  const start = useCallback(() => {
    const host = optionsRef.current.captureHost;
    if (host === null || disabled) return;
    if (phase === 'requesting' || phase === 'recording') return;

    const token = latch.begin();
    controllerRef.current?.abort();
    controllerRef.current = null;
    releaseRequested.current = false;
    setInputMonitor(null);
    setError(null);
    setPhase('requesting');

    // NO await between here and `startCapture` — the permission prompt has to be
    // attributable to the gesture that called us.
    startCapture(host, {
      onLimit: () => void finish(token),
      onAbort: () => {
        // The tab went to the background and the microphone closed underneath
        // us. Treat it as a cancellation: invalidate the generation so nothing
        // in flight can commit, and return the control to idle — otherwise the
        // button stays pressed-looking and the next `start()` is refused for an
        // utterance that no longer exists.
        if (!latch.abort(token)) return;
        releaseRequested.current = false;
        setInputMonitor(null);
        setError(null);
        setPhase('idle');
      },
    })
      .then((active: CaptureSession) => {
        // `attach` refuses a stale token, which is the case where a cancel or a
        // background abort landed while the permission prompt was still up.
        if (!latch.attach(token, active)) {
          active.cancel();
          return;
        }
        if (releaseRequested.current) {
          // The reader let go while the permission prompt was still up. Honour
          // the release rather than starting a recording nobody asked for.
          releaseRequested.current = false;
          void finish(token);
          return;
        }
        setInputMonitor(active);
        setPhase('recording');
      })
      .catch((failure: unknown) => {
        if (!latch.isCurrent(token)) return;
        const captureFailure = captureErrorFrom(failure);
        setInputMonitor(null);
        setError({ code: captureFailure.code, message: captureFailure.message });
        setPhase('error');
      });
  }, [disabled, finish, latch, phase]);

  const stop = useCallback(() => {
    if (latch.liveCapture === null) {
      // Either the device has not opened yet — remember the release rather than
      // ignoring it — or something else already claimed this utterance (the
      // 120-second limit, a cancel, a background abort), in which case there is
      // nothing here to finish.
      if (phase === 'requesting') releaseRequested.current = true;
      return;
    }
    if (phase !== 'recording' && phase !== 'requesting') return;
    void finish(latch.generation);
  }, [finish, latch, phase]);

  const cancel = useCallback(() => {
    teardown();
    setInputMonitor(null);
    setError(null);
    setPhase('idle');
  }, [teardown]);

  const dismissError = useCallback(() => {
    setError(null);
    setPhase(current => (current === 'error' ? 'idle' : current));
  }, []);

  return {
    supported,
    phase,
    recording: phase === 'recording',
    inputMonitor,
    busy: phase === 'transcribing',
    error,
    start,
    stop,
    cancel,
    dismissError,
  };
}
