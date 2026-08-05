/**
 * Browser-side dictation: one recognition session, one transcript, and exactly
 * one way for text to leave it.
 *
 * There is no `onSubmit`, no `onSend`, and no path from recognised words to a
 * message being sent. `onDraft` is called once, after recognition finishes and
 * optional correction has run, with the COMPLETE next draft and caret.
 *
 * `start()` calls the browser's SpeechRecognition synchronously from the mic
 * button. The browser owns the microphone and returns words directly; no audio
 * buffer, recording, or recognition request is sent to a Ferretry daemon.
 *
 * Every async boundary checks a generation. A duration limit and Stop can race,
 * a cancelled browser can deliver a late result, and enhancement can resolve
 * after unmount. Only the first current owner can commit.
 *
 * The paired daemon remains explicit for two OPTIONAL text-only operations:
 * recent conversation read as correction vocabulary, and Groq enhancement.
 * Local correction never sends the transcript across that boundary, and audio
 * cannot cross it.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import {
  type BrowserRecognitionProvider,
  BrowserRecognitionSession,
  type BrowserRecognitionSessionLike,
  browserRecognitionErrorFrom,
  browserRecognitionProvider,
} from '../lib/stt/browser-recognition.ts';
import { insertTranscript, readSelection, type SelectionLike } from '../lib/stt/draft.ts';
import { enhance } from '../lib/stt/enhancement.ts';
import { type RemoteEnhancementFetch, requestRemoteEnhancement } from '../lib/stt/remote-enhancement.ts';
import { type SttSettings, sttDictionary } from '../lib/stt/stt-settings.ts';
import { verifyWordOnly } from '../lib/stt/word-only-verifier.ts';

/**
 * What the panel shows and what the push-to-talk shortcut reads.
 *
 * Owned here rather than by the recognition port: `transcribing` covers the
 * enhancement round trip this hook runs after the browser has settled its
 * words, which the port itself knows nothing about.
 */
export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';

export interface DictationError {
  readonly code: string;
  readonly message: string;
}

export interface DictationDraftResult {
  /** The complete next draft value — not the transcript on its own. */
  readonly text: string;
  /** Where the caret should sit afterwards. */
  readonly caret: number;
  /** Raw words already landed; only optional correction failed. */
  readonly enhancementError?: DictationError;
}

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
    texts.push(text);
  }
  return texts.slice(-MAX_CONTEXT_MESSAGES);
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
  readonly settings: SttSettings;
  /** Browser recognition and visibility surface; injected by tests/harness. */
  readonly recognition?: BrowserRecognitionProvider;
  /** Optional text-only correction transport through the paired daemon. */
  readonly enhancementFetch?: RemoteEnhancementFetch;
  readonly disabled?: boolean;
}

export interface DictationHandle {
  /** False when recognition is unavailable here. The control still says so. */
  readonly supported: boolean;
  readonly phase: DictationPhase;
  readonly recording: boolean;
  /** Browser interim/final words. Read-only preview; never the output seam. */
  readonly liveText: string;
  readonly error: DictationError | null;
  readonly busy: boolean;
  /** Call synchronously from the reader gesture. */
  start(): void;
  stop(): void;
  cancel(): void;
  dismissError(): void;
}

export function useDictation(options: UseDictationOptions): DictationHandle {
  const disabled = Boolean(options.disabled || !options.settings.enabled);
  const ambientRecognition = useMemo(() => browserRecognitionProvider(), []);
  const recognition = options.recognition ?? ambientRecognition;
  const supported = recognition.support.available;

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<DictationError | null>(null);
  const [liveText, setLiveText] = useState('');

  // Refs, not state: recognition and enhancement continuations outlive the
  // render that started them.
  const generationRef = useRef(0);
  const liveSessionRef = useRef<BrowserRecognitionSessionLike | null>(null);
  const finishingSessionRef = useRef<BrowserRecognitionSessionLike | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  const recognitionRef = useRef(recognition);
  optionsRef.current = options;
  recognitionRef.current = recognition;

  const isCurrent = useCallback((token: number): boolean => generationRef.current === token, []);

  /** Cancel every owner and return the next generation token. */
  const invalidate = useCallback((): number => {
    generationRef.current += 1;
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
  }, []);

  // Unmount releases the browser microphone and suppresses every continuation.
  useEffect(() => () => void invalidate(), [invalidate]);

  useEffect(() => {
    if (!disabled) return;
    invalidate();
    setLiveText('');
    setError(null);
    setPhase('idle');
  }, [disabled, invalidate]);

  const commit = useCallback((transcript: string, enhancementError?: DictationError) => {
    const spoken = transcript.trim();
    if (spoken.length === 0) return;
    const current = optionsRef.current;
    const [start, end] = readSelection(current.selectionRef?.current, current.draft);
    const result = insertTranscript(current.draft, start, end, spoken);
    // THE ONLY OUTPUT.
    current.onDraft({ ...result, ...(enhancementError ? { enhancementError } : {}) });
  }, []);

  /** Recent conversation for the enhancer, or nothing. Never an error. */
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
      return [];
    }
  }, []);

  /** Correct the raw words or return them untouched. */
  const enhanceTranscript = useCallback(
    async (raw: string, token: number, onFailure: (failure: DictationError) => void): Promise<string> => {
      const current = optionsRef.current;
      const active = current.settings;
      if (!active.enhancement) return raw;
      const { entries } = sttDictionary(active);
      const context = await readContext();
      if (!isCurrent(token)) return raw;

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
          if (!isCurrent(token) || controllerRef.current?.signal.aborted === true) return raw;
          onFailure(enhancementErrorFrom(failure));
          return raw;
        }
      }

      const candidate = enhance({ text: raw, dictionary: entries, context, userContext: active.userContext });
      if (candidate.text === raw) return raw;
      // Enhancement can improve recognition, never cost the original words.
      return verifyWordOnly(raw, candidate.text).ok ? candidate.text : raw;
    },
    [isCurrent, readContext],
  );

  /** Claim and finish this generation exactly once. */
  const finish = useCallback(
    async (token: number, session: BrowserRecognitionSessionLike): Promise<void> => {
      if (!isCurrent(token) || liveSessionRef.current !== session) return;
      liveSessionRef.current = null;
      finishingSessionRef.current = session;
      setPhase('transcribing');

      let enhancementFailure: DictationError | null = null;
      try {
        const raw = await session.finish();
        if (!isCurrent(token)) return;
        if (raw.trim().length === 0) {
          setLiveText('');
          setPhase('idle');
          return;
        }

        controllerRef.current = new AbortController();
        const text = await enhanceTranscript(raw, token, failure => {
          enhancementFailure = failure;
        });
        if (!isCurrent(token)) return;
        commit(text, enhancementFailure ?? undefined);
        if (enhancementFailure !== null) {
          setError(enhancementFailure);
          setPhase('error');
        } else {
          setLiveText('');
          setPhase('idle');
        }
      } catch (failure) {
        if (!isCurrent(token)) return;
        const recognitionFailure = browserRecognitionErrorFrom(failure);
        if (recognitionFailure.code === 'aborted') {
          setLiveText('');
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
    [commit, enhanceTranscript, isCurrent],
  );

  const start = useCallback(() => {
    if (disabled || phase === 'requesting' || phase === 'recording') return;

    const provider = recognitionRef.current;
    const token = invalidate();
    setLiveText('');
    setError(null);
    setPhase('requesting');

    if (!provider.support.available) {
      setError({
        code: 'recognition-unavailable',
        message: provider.support.reason ?? 'Dictation is unavailable in this browser.',
      });
      setPhase('error');
      return;
    }

    let session: BrowserRecognitionSession | null = null;
    try {
      session = new BrowserRecognitionSession(provider, {
        onStart: () => {
          if (isCurrent(token)) setPhase('recording');
        },
        onTranscript: text => {
          if (isCurrent(token)) setLiveText(text);
        },
        onFailure: failure => {
          if (!isCurrent(token)) return;
          if (liveSessionRef.current === session) liveSessionRef.current = null;
          setError({ code: failure.code, message: failure.message });
          setPhase('error');
        },
        onAbort: () => {
          if (!isCurrent(token)) return;
          invalidate();
          setLiveText('');
          setError(null);
          setPhase('idle');
        },
        onLimit: () => {
          if (session !== null) void finish(token, session);
        },
      });
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
  }, [disabled, finish, invalidate, isCurrent, phase]);

  const stop = useCallback(() => {
    const session = liveSessionRef.current;
    if (session === null || (phase !== 'recording' && phase !== 'requesting')) return;
    void finish(generationRef.current, session);
  }, [finish, phase]);

  const cancel = useCallback(() => {
    invalidate();
    setLiveText('');
    setError(null);
    setPhase('idle');
  }, [invalidate]);

  const dismissError = useCallback(() => {
    setError(null);
    setPhase(current => (current === 'error' ? 'idle' : current));
  }, []);

  return {
    supported,
    phase,
    recording: phase === 'recording',
    liveText,
    busy: phase === 'transcribing',
    error,
    start,
    stop,
    cancel,
    dismissError,
  };
}
