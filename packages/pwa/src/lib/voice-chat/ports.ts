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
  /**
   * Close the microphone NOW and keep what was already asked for: the early finish's snapshot and its pending
   * decode still answer `endTurn`. A decode that stalls can no longer leave the person's microphone open.
   * Idempotent; after it the take cannot record on (`resume` answers false).
   */
  stopRecording(): void;
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
 * One approved send: the exact words Live put on screen and a way to take the approval back. It is the ONLY
 * thing that lets Live send, and it is revocable until the composer starts the send: Hold, typing, a hidden tab
 * and End all revoke it, so nothing is sent that was not on screen exactly as sent, and never after a stop.
 */
export interface SendTicket {
  /** The words on screen when the send was approved: the composer sends exactly these or nothing. */
  readonly text: string;
  /** The approval was taken back (Hold, typing, a hidden tab, End, the page leaving). */
  readonly revoked: boolean;
  /**
   * Called by the composer IMMEDIATELY before it starts the send, once it holds exactly `text`. True: go — from here
   * the send is on its way and a stop can no longer take it back. False: revoked (or the page is hidden) — send nothing.
   */
  commit(): boolean;
}

/**
 * The composer, seen from Live. `show` puts the turn's words in the box where the person can see and
 * edit them; `send` sends exactly what the ticket approved, through the composer's own send (same route,
 * grants, ledger and audit as a typed message). Live has no other way to send.
 */
export interface SendPort {
  /** Replace this turn's words in the box (the text typed before Live, and earlier takes' words, stay in front). */
  show(words: string): void;
  /** Take this turn's words out of the box again (a take that came to nothing). */
  clear(): void;
  /** What is in the box now is final for this take: the next take's words go AFTER it, never over it. */
  seal(): void;
  /** What the box holds right now: what `send` will send. */
  shown(): string;
  /** The text in the box that is NOT Live's words: whatever a person typed, '' when there is none. */
  typed(): string;
  /** Send exactly `ticket.text` — or nothing, when the ticket is revoked or the box no longer holds it. */
  send(ticket: SendTicket): Promise<SendOutcome>;
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
 * How one reading of a reply ended. `stopped` is a stop (the person's, or the voice going quiet under it).
 * `taken` is NOT an end of speech: another message took the page's one voice and is speaking now.
 */
export type ReadEnd = 'finished' | 'stopped' | 'failed' | 'unavailable' | 'taken';

/** What Live reads when a turn ends: the ferret's reply, or the question it is waiting on. */
export type ReadWhat = 'reply' | 'question';

/**
 * Reading a turn's words aloud, as Live sees it. The words come from the conversation on the page, never
 * from the machine: Live only says WHEN to read and WHAT KIND of thing (`reply` or `question`), and hears
 * how it ended. `read` calls `onEnd` exactly once, however it ends, and never throws.
 */
export interface ReaderPort {
  /** False where the device has no speech at all: Live then shows the reply and listens again. */
  readonly supported: boolean;
  /** Make later speech allowed. Called INSIDE the person's tap (iOS only lets speech start from one). */
  unlock(): void;
  /** A message is about to be sent: remember what the page holds, so the reply is the first thing after it. */
  mark(): void;
  /** Read the turn's reply or question. Replaces a reading still going (which is told `stopped`). Another message taking the voice mid-reading is told `taken`. */
  read(what: ReadWhat, onEnd: (end: ReadEnd) => void): void;
  /** Stop at once. The reading in progress hears `stopped`; with none, nothing happens. */
  stop(): void;
}

/**
 * The page's ONE voice, as Live must respect it: a device speaks with one voice, and Live's microphone never opens while
 * anything — a reading Live started, a Read aloud tap on an older message, the settings preview — is speaking, or it
 * would hear the speaker and send the ferret's own words back to the ferret.
 */
export interface VoicePort {
  /** Something is speaking now. Never throws. */
  busy(): boolean;
  /** Told whenever `busy()` may have changed; returns its cancel. */
  watch(onChange: () => void): () => void;
  /** Silence the voice at once, whoever holds it. */
  silence(): void;
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
/** One voice the device can speak with. `local` is the browser's own `localService`: it stays on the device. */
export interface SpeakerVoice {
  /** The browser's `voiceURI`: stable enough to name the voice again. */
  readonly id: string;
  readonly name: string;
  /** BCP 47, as the browser reports it ("en-US"). */
  readonly lang: string;
  /** True when the voice is built into the device and speaks without sending text anywhere. */
  readonly local: boolean;
  /** The device's own pick for its language. */
  readonly isDefault: boolean;
}

/** What a speaker tells the one who asked it to speak. Every reading ends in exactly one of the last three. */
export type SpeakerEvent =
  /** This segment has just started to be said: the caption moves to it. */
  | { readonly type: 'segment'; readonly index: number }
  /** Everything was said. */
  | { readonly type: 'end' }
  /** `stop()` was called, or another reading replaced this one. */
  | { readonly type: 'stopped' }
  /** Speech was not possible or broke off. `unavailable`: this device cannot speak at all. */
  | { readonly type: 'error'; readonly reason: 'unavailable' | 'failed' };

export interface SpeakRequest {
  /** One entry per caption: the speaker may split an entry further for the engine, but reports it as one. */
  readonly segments: readonly string[];
  /** Speech rate, 0.8 – 2.0 (the speaker clamps). */
  readonly rate: number;
  /**
   * The voice to use, already vetted by the caller (who says in words if it sends text away). Absent or no
   * longer there: the speaker picks a voice that stays on the device for `language` itself — and when it
   * cannot, it refuses (`error`) rather than hand the text to the browser's unset default, which may be remote.
   */
  readonly voice?: SpeakerVoice | null;
  /** BCP 47 language of the text, for a speaker that has to choose its own voice. */
  readonly language?: string;
}

export interface SpeakerPort {
  /** False where the device has no speech at all, so a screen offers no Read aloud. */
  readonly supported: boolean;
  /** What the device can speak with right now. May be empty at first: browsers load voices late. */
  voices(): readonly SpeakerVoice[];
  /**
   * Make later speech allowed. iOS only lets speech start from a tap, so a caller that will speak later
   * calls this INSIDE the tap. Safe to call any number of times, and never audible.
   */
  unlock(): void;
  /** Say the request, replacing any reading already going (which hears `stopped`). */
  speak(request: SpeakRequest, onEvent: (event: SpeakerEvent) => void): void;
  /** Stop at once. The reading in progress hears `stopped`; with none, nothing happens. */
  stop(): void;
}

/** The short tones Live makes so a person who is not looking knows where it is. */
export type EarconKind = 'listening' | 'sent' | 'reply-ready' | 'stopped';

export interface EarconPort {
  /** Make the tone's sound. Never throws; silent where the device cannot. */
  play(kind: EarconKind): void;
  /** Allow later sound. Called INSIDE the person's tap (a page may not sound before one). */
  unlock(): void;
}

/** A short buzz where the device has one (Android; iOS web has none). */
export interface HapticsPort {
  pulse(kind: 'sent' | 'reply-ready'): void;
}
