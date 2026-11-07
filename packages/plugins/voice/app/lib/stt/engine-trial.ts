/**
 * TRY AN ENGINE — record a few seconds, transcribe them, and say how long each part took, so the
 * person can compare engines side by side in Settings › Voice before choosing one.
 *
 * It drives the same session contract dictation does (`on-device-voice.ts`), so what a trial measures
 * is what dictating with that engine costs: the microphone opening, the first words while speaking
 * (for an engine that has live words), and the wait between the recording ending and the text.
 * Nothing it hears goes anywhere but the screen: the trial never touches a draft or the transcription
 * log.
 */

import { BrowserRecognitionError } from './browser-recognition.ts';
import { joinWords } from './near-live.ts';
import type { OnDeviceSession, OnDeviceSessionOptions } from './on-device-voice.ts';

/** How long a trial records. */
export const TRIAL_RECORD_MS = 5_000;

type EngineTrialPhase = 'opening' | 'recording' | 'transcribing';

export interface EngineTrialResult {
  readonly text: string;
  /** Pressing Try it → the microphone open and recording. */
  readonly openMs: number;
  /** How long it recorded. */
  readonly recordedMs: number;
  /** Recording start → the first word on screen, or `null` when no words appeared before the end. */
  readonly firstWordMs: number | null;
  /** Recording end → the final text: the wait a dictation adds after Stop. */
  readonly finishMs: number;
  /** The one-time model load this take paid for, when the engine reports one. */
  readonly loadMs: number | null;
  /** What ran the take, when the engine says — the model, and for Whisper the backend ("… · WebGPU"). */
  readonly model?: string;
}

export interface EngineTrialPorts {
  /** Opens one session; throws (before the microphone opens) when the engine cannot run. */
  open(options: OnDeviceSessionOptions): OnDeviceSession;
  /** Milliseconds on a monotonic clock. */
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Defaults to {@link TRIAL_RECORD_MS}. */
  readonly recordMs?: number;
}

export interface EngineTrialUpdate {
  readonly phase: EngineTrialPhase;
  /** Words heard so far, for an engine that shows them while recording. */
  readonly live: string;
}

export interface EngineTrial {
  /** Settles with the measurements, or rejects with a `BrowserRecognitionError`. */
  readonly result: Promise<EngineTrialResult>;
  /** Stops the trial and drops what it heard. */
  cancel(): void;
}

/** Start a trial. Call from the button's own click, so the permission prompt belongs to it. */
export function startEngineTrial(ports: EngineTrialPorts, onUpdate: (update: EngineTrialUpdate) => void): EngineTrial {
  const pressedAt = ports.now();
  let startedAt: number | null = null;
  let firstWordAt: number | null = null;
  let timer: unknown = null;
  let settled = false;
  let stopped = false;
  let session: OnDeviceSession | null = null;
  let resolveResult!: (result: EngineTrialResult) => void;
  let rejectResult!: (error: BrowserRecognitionError) => void;
  const result = new Promise<EngineTrialResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const clear = (): void => {
    if (timer === null) return;
    ports.clearTimeout(timer);
    timer = null;
  };
  const fail = (error: BrowserRecognitionError): void => {
    if (settled) return;
    settled = true;
    clear();
    rejectResult(error);
  };
  const heard = (text: string): void => {
    if (settled || startedAt === null || text.trim() === '') return;
    firstWordAt ??= ports.now();
    onUpdate({ phase: 'recording', live: text.trim() });
  };
  const stop = (): void => {
    const active = session;
    if (settled || stopped || active === null || startedAt === null) return;
    stopped = true;
    clear();
    const began = startedAt;
    const stoppedAt = ports.now();
    onUpdate({ phase: 'transcribing', live: '' });
    active.finish().then(
      text => {
        if (settled) return;
        settled = true;
        const timings = active.timings?.();
        const loadMs = timings?.loadMs;
        resolveResult({
          text: text.trim(),
          openMs: Math.max(0, began - pressedAt),
          recordedMs: Math.max(0, stoppedAt - began),
          firstWordMs: firstWordAt === null ? null : Math.max(0, firstWordAt - began),
          finishMs: Math.max(0, ports.now() - stoppedAt),
          loadMs: loadMs === undefined ? null : Math.max(0, loadMs),
          ...(timings?.model === undefined ? {} : { model: timings.model }),
        });
      },
      (error: unknown) =>
        fail(
          error instanceof BrowserRecognitionError
            ? error
            : new BrowserRecognitionError('recognition-failed', 'The engine could not transcribe the trial.'),
        ),
    );
  };

  onUpdate({ phase: 'opening', live: '' });
  try {
    session = ports.open({
      liveWords: true,
      onStart: () => {
        if (settled || startedAt !== null) return;
        startedAt = ports.now();
        onUpdate({ phase: 'recording', live: '' });
        timer = ports.setTimeout(stop, ports.recordMs ?? TRIAL_RECORD_MS);
      },
      onTranscript: heard,
      onLive: state => heard(joinWords(state.committed, state.interim)),
      onFailure: fail,
      onAbort: () => fail(new BrowserRecognitionError('aborted', 'The trial stopped when this page was hidden.')),
      onLimit: stop,
    });
    session.start();
  } catch (error) {
    fail(
      error instanceof BrowserRecognitionError
        ? error
        : new BrowserRecognitionError('recognition-unavailable', 'This engine cannot run here.'),
    );
  }

  return {
    result,
    cancel: () => {
      if (settled) return;
      session?.cancel();
      fail(new BrowserRecognitionError('aborted', 'The trial was cancelled.'));
    },
  };
}

/** "1.2 s", the way the trial reports a duration. */
export const formatSeconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)} s`;
