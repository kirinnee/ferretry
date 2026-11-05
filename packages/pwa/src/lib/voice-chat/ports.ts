/**
 * THE EDGES OF LIVE VOICE: every thing the loop touches that is not pure.
 *
 * `live-machine.ts` decides; these interfaces are how a decision reaches the world and how the world
 * answers. Each is small and total (no method throws: a failure is a value), so the runner
 * (`live-runner.ts`) is tested with plain fakes and the real adapters sit behind the same seams.
 * Three-layer rule (docs/standards/three-layer-architecture): the machine and runner know only this
 * file, never `window`, a timer, a worker or `fetch`.
 *
 * The microphone is closed in every state that is not listening: the take and the level frames are
 * both stopped together (`MicPort`), so there is no state in which Live hears anything it is not
 * about to put on screen.
 */

import type { LevelFrame } from './turn-endpointer.ts';

/** Why Live could not open the microphone or the engine. The words for each live in `live-copy.ts`. */
export type LiveBlock =
  | 'mic-blocked'
  | 'engine-not-chosen'
  | 'engine-missing'
  | 'engine-failed'
  | 'no-send-rights'
  | 'other-tab'
  | 'ios-browser-voice';

/** The turn's words once its take is over. */
export type TakeOutcome =
  | { readonly kind: 'words'; readonly text: string; readonly raw: string; readonly cleaned: boolean }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed'; readonly block: LiveBlock };

/** What a running take tells its owner while it records. */
export interface TakeListener {
  /** Words heard so far, as the engine reports them (Browser voice, Vosk, near-live Parakeet). Never the output. */
  onLive(text: string): void;
  /** The engine ended the take on its own (its duration limit, or the browser abandoned it). */
  onEnded(): void;
  /** The engine could not run (permission, model, network). */
  onFailed(block: LiveBlock): void;
}

/**
 * One recording of one turn, over the dictation engines the person already chose. `endTurn` is the
 * "pause held" call: it works out the turn's words (early, with the recording left open, where the
 * engine offers that; by finishing the engine otherwise) and cleans them with the Fix style. `resume`
 * undoes it when the voice comes back: the early work is thrown away and recording carries on, with
 * the words so far kept in front of whatever is said next.
 */
export interface TakeHandle {
  endTurn(): Promise<TakeOutcome>;
  /** The speaker is back: record on. Resolves once recording is open again (false: it could not be). */
  resume(): Promise<boolean>;
  /** Stop and forget everything, microphone included. Idempotent. */
  cancel(): void;
}

export interface TakePort {
  /** Start recording. Called from the person's tap (the permission prompt belongs to the gesture). */
  start(listener: TakeListener): TakeHandle;
}

/** The loudness of the microphone, 20 ms at a time, for the endpointer. One stream at a time. */
export interface LevelFramesPort {
  /** Open the meter. `null` when this page cannot measure (the loop then cannot hear a pause). */
  open(onFrame: (frame: LevelFrame) => void): Promise<LevelMeterHandle | null>;
}

export interface LevelMeterHandle {
  /** The most recent levels, oldest first, so a new endpointer knows the room's floor at once. */
  recent(): readonly number[];
  release(): void;
}

/** The result of putting the composer's words on the wire, as the composer's own send reports it. */
export type SendOutcome =
  | { readonly kind: 'sent'; readonly sentAtMs: number }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The composer, seen from Live. `show` puts the turn's words in the box where the person can see and
 * edit them; `send` sends exactly what the box holds, through the composer's own send (same route,
 * grants, ledger and audit as a typed message). Live has no other way to send.
 */
export interface SendPort {
  /** Replace this turn's words in the box (the text typed before Live stays in front of them). */
  show(words: string): void;
  /** Take this turn's words out of the box again (a take that came to nothing). */
  clear(): void;
  /** What the box holds right now: what `send` will send. */
  shown(): string;
  send(): Promise<SendOutcome>;
}

/** The ferret's side of the turn, from the session the page already holds. No new route. */
export type ReplySignal =
  | { readonly kind: 'working' }
  | { readonly kind: 'done' }
  | { readonly kind: 'needs-input' }
  | { readonly kind: 'ended' };

/** One send's watch on the ferret, armed before the message goes and attached once it is acknowledged. */
export interface ReplyWatch {
  /**
   * The send was acknowledged: report what the ferret did since the watch was armed (a turn that finished
   * while the send was still being acknowledged is not lost), then every change from here on. Returns the
   * unsubscribe, which also ends the watch.
   */
  attach(onSignal: (signal: ReplySignal) => void): () => void;
  /** The send did not happen, or Live ended first: stop listening. Idempotent. */
  cancel(): void;
}

export interface ReplyFeedPort {
  /** Take the baseline and start listening. Called BEFORE the message is submitted. */
  arm(): ReplyWatch;
}

/**
 * Reading a reply aloud. Slice 5 wires a real one; in this slice the runner holds `null` and the
 * machine's Reading state and `speak` / `stopSpeaking` effects are exercised with a fake.
 */
export interface SpeakerPort {
  speak(onDone: () => void): void;
  stop(): void;
}

export interface WakeLockPort {
  /** Keep the screen on. Resolves false when the browser refuses (Live still works). */
  acquire(): Promise<boolean>;
  release(): void;
}

export interface VisibilityPort {
  /** Whether the page is on screen now. */
  visible(): boolean;
  watch(onChange: (visible: boolean) => void): () => void;
}

/** Only one tab in a browser may be Live. */
export interface MicLockPort {
  /** Resolves false when another tab holds it. */
  acquire(): Promise<boolean>;
  release(): void;
}

export interface ClockPort {
  /** Monotonic milliseconds. */
  now(): number;
  /** Run `callback` once after `ms`; returns its cancel. */
  after(ms: number, callback: () => void): () => void;
}
