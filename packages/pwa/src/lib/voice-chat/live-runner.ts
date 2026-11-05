/**
 * THE LIVE LOOP'S HANDS: holds the machine's state, feeds it events, and does what its effects say
 * through the ports of `ports.ts`. It decides nothing — every rule is in `live-machine.ts` — and it
 * touches nothing real: with fake ports it runs the whole loop in a unit test, which is how its races
 * are proved.
 *
 * ONE QUEUE. An effect can cause an event at once (a fake port answers synchronously), and an event
 * can come while another is being handled. Events are queued and handled one at a time, in order, so
 * the state a handler sees is always the state the previous event left.
 *
 * GENERATIONS. Opening the microphone starts a generation; closing it ends it. Every answer from
 * the take or the level meter carries the generation it was asked in, and an answer for an ended one
 * is dropped (and its meter released), so a slow permission prompt can never reopen a microphone
 * the person already closed.
 *
 * THE ENDPOINTER IS RESTARTED, NOT RESET, after a turn ends: a fresh one is seeded with the room's
 * recent levels, so the voice coming back during the countdown is heard as "speech starts" and the
 * countdown is cancelled — the microphone stays open for exactly that.
 */

import {
  INITIAL_LIVE_STATE,
  type LiveEffect,
  type LiveEvent,
  type LiveState,
  liveReduce,
  type TurnNumbers,
} from './live-machine.ts';
import type {
  ClockPort,
  LevelFramesPort,
  LevelMeterHandle,
  MicLockPort,
  ReplyFeedPort,
  SendPort,
  SpeakerPort,
  TakeHandle,
  TakePort,
  VisibilityPort,
  WakeLockPort,
} from './ports.ts';
import { type EndpointerState, endpointerFeed, endpointerStart, type LevelFrame } from './turn-endpointer.ts';

export interface LiveRunnerPorts {
  readonly take: TakePort;
  readonly levels: LevelFramesPort;
  readonly send: SendPort;
  readonly reply: ReplyFeedPort;
  /** Null until slice 5 wires reading aloud. */
  readonly speaker: SpeakerPort | null;
  readonly wakeLock: WakeLockPort;
  readonly visibility: VisibilityPort;
  readonly micLock: MicLockPort;
  readonly clock: ClockPort;
}

export interface LiveRunnerOptions {
  /** This device may send (the composer's own grants): without it Live refuses to start. */
  readonly canSend: boolean;
  /** The countdown before a send, ms. Resolved (clamped) by the machine. */
  readonly graceMs?: unknown;
  /** The pause that ends a turn: a preset name or ms. Resolved by the endpointer. */
  readonly pauseMs?: unknown;
  /** One call per sent turn with its numbers. Never words. */
  readonly onTurn?: (numbers: TurnNumbers) => void;
}

/** How many level bars the bar draws. */
export const LEVEL_HISTORY = 32;

const toBar = (rms: number): number => Math.min(1, Math.sqrt(Math.max(0, rms)) * 2.5);

export class LiveRunner {
  readonly #ports: LiveRunnerPorts;
  readonly #options: LiveRunnerOptions;
  readonly #listeners = new Set<() => void>();
  readonly #timers = new Map<string, () => void>();
  readonly #queue: LiveEvent[] = [];
  #state: LiveState = INITIAL_LIVE_STATE;
  #processing = false;
  #disposed = false;

  #micGen = 0;
  #handle: TakeHandle | null = null;
  #meter: LevelMeterHandle | null = null;
  #endpointer: EndpointerState | null = null;
  #levels: number[] = [];
  #countdownCancel: (() => void) | null = null;
  #replyCancel: (() => void) | null = null;
  #unwatchVisibility: (() => void) | null = null;
  #screenMayTurnOff = false;
  #lockHeld = false;
  #lockAsked = false;

  constructor(ports: LiveRunnerPorts, options: LiveRunnerOptions) {
    this.#ports = ports;
    this.#options = options;
  }

  get state(): LiveState {
    return this.#state;
  }

  /** The machine's clock now, for the bar's countdown. */
  now(): number {
    return this.#ports.clock.now();
  }

  /** The newest level bars, oldest first, each 0..1. */
  levels(): readonly number[] {
    return this.#levels;
  }

  /** The wake lock was refused: Live works, but the screen may turn off. */
  get screenMayTurnOff(): boolean {
    return this.#screenMayTurnOff;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Call synchronously from the person's tap: the microphone prompt belongs to the gesture. */
  start(): void {
    this.#unwatchVisibility ??= this.#ports.visibility.watch(visible => this.dispatch({ type: 'visibility', visible }));
    this.dispatch({
      type: 'start',
      atMs: this.#ports.clock.now(),
      canSend: this.#options.canSend,
      visible: this.#ports.visibility.visible(),
      graceMs: this.#options.graceMs,
      canRead: this.#ports.speaker !== null,
    });
  }

  hold(): void {
    this.dispatch({ type: 'hold' });
  }

  sendNow(): void {
    this.dispatch({ type: 'send-now', atMs: this.#ports.clock.now() });
  }

  resume(): void {
    this.dispatch({ type: 'resume' });
  }

  end(): void {
    this.dispatch({ type: 'end' });
  }

  skip(): void {
    this.dispatch({ type: 'skip' });
  }

  /** The person edited the composer: auto-send pauses. */
  typing(): void {
    this.dispatch({ type: 'typing' });
  }

  /** Close everything for good (the page is leaving). No notice, no events afterwards. */
  dispose(): void {
    this.#disposed = true;
    this.#queue.length = 0;
    this.#unwatchVisibility?.();
    this.#unwatchVisibility = null;
    this.#closeMic();
    this.#clearCountdown();
    this.#clearTimers();
    this.#stopReply();
    this.#ports.speaker?.stop();
    this.#releaseLocks();
    this.#listeners.clear();
  }

  dispatch(event: LiveEvent): void {
    if (this.#disposed) return;
    this.#queue.push(event);
    if (this.#processing) return;
    this.#processing = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        const step = liveReduce(this.#state, next);
        this.#state = step.state;
        for (const effect of step.effects) this.#perform(effect);
        for (const listener of this.#listeners) listener();
      }
    } finally {
      this.#processing = false;
    }
  }

  #perform(effect: LiveEffect): void {
    switch (effect.type) {
      case 'acquireLocks':
        return this.#acquireLocks();
      case 'releaseLocks':
        return this.#releaseLocks();
      case 'openMic':
        return this.#openMic();
      case 'closeMic':
        return this.#closeMic();
      case 'beginTurnWords':
        return this.#beginTurnWords(effect.attempt);
      case 'resumeListening':
        return this.#resumeListening();
      case 'startCountdown':
        return this.#startCountdown(effect.ms);
      case 'cancelCountdown':
        return this.#clearCountdown();
      case 'startTimer':
        return this.#startTimer(effect.kind, effect.ms);
      case 'cancelTimers':
        return this.#clearTimers();
      case 'showWords':
        return this.#ports.send.show(effect.text);
      case 'clearWords':
        return this.#ports.send.clear();
      case 'send':
        return this.#send();
      case 'watchReply':
        return this.#watchReply();
      case 'stopWatchReply':
        return this.#stopReply();
      case 'speak':
        return this.#speak();
      case 'stopSpeaking':
        return this.#ports.speaker?.stop();
      case 'recordTurn':
        return this.#options.onTurn?.(effect.numbers);
    }
  }

  // — locks ————————————————————————————————————————————————————————————

  #acquireLocks(): void {
    void this.#ports.wakeLock.acquire().then(granted => {
      if (!this.#disposed) this.#screenMayTurnOff = !granted;
    });
    if (this.#lockHeld) {
      // Resuming in the same tab: the mic lock is still ours.
      this.dispatch({ type: 'locks', granted: true });
      return;
    }
    if (this.#lockAsked) return;
    this.#lockAsked = true;
    void this.#ports.micLock.acquire().then(granted => {
      this.#lockAsked = false;
      this.#lockHeld = granted;
      this.dispatch({ type: 'locks', granted });
    });
  }

  #releaseLocks(): void {
    this.#lockHeld = false;
    this.#ports.micLock.release();
    this.#ports.wakeLock.release();
  }

  // — the microphone ————————————————————————————————————————————————————

  #openMic(): void {
    this.#closeMic();
    const gen = this.#micGen;
    const handle = this.#ports.take.start({
      onLive: text => {
        if (gen === this.#micGen) this.dispatch({ type: 'live-words', text });
      },
      onEnded: () => {
        if (gen === this.#micGen) this.#takeEnded();
      },
      onFailed: block => {
        if (gen === this.#micGen) this.dispatch({ type: 'blocked', block });
      },
    });
    this.#handle = handle;
    void this.#ports.levels
      .open(frame => this.#frame(gen, frame))
      .then(
        meter => this.#meterOpened(gen, meter),
        () => this.#meterOpened(gen, null),
      );
  }

  #meterOpened(gen: number, meter: LevelMeterHandle | null): void {
    if (gen !== this.#micGen) {
      meter?.release();
      return;
    }
    if (meter === null) {
      this.dispatch({ type: 'blocked', block: 'mic-blocked' });
      return;
    }
    this.#meter = meter;
    this.#endpointer = endpointerStart(this.#options.pauseMs, { floorLevels: meter.recent() });
    this.dispatch({ type: 'listening' });
  }

  #closeMic(): void {
    this.#micGen += 1;
    this.#endpointer = null;
    this.#levels = [];
    const handle = this.#handle;
    const meter = this.#meter;
    this.#handle = null;
    this.#meter = null;
    handle?.cancel();
    meter?.release();
  }

  /** The engine ended the take by itself: its own limit, or the browser gave up. */
  #takeEnded(): void {
    const { phase } = this.#state;
    const now = this.#ports.clock.now();
    if (phase === 'hearing') this.dispatch({ type: 'turn-end', atMs: now, speechEndedAtMs: now, reason: 'max-turn' });
    else if (phase === 'listening') this.#resumeListening();
  }

  #frame(gen: number, frame: LevelFrame): void {
    if (gen !== this.#micGen || this.#endpointer === null) return;
    this.#levels = [...this.#levels.slice(1 - LEVEL_HISTORY), toBar(frame.rms)];
    const step = endpointerFeed(this.#endpointer, frame);
    this.#endpointer = step.state;
    for (const event of step.events) {
      switch (event.kind) {
        case 'speech-start':
          this.dispatch({ type: 'speech-start' });
          break;
        case 'speech-cancel':
          this.dispatch({ type: 'speech-cancel', atMs: event.atMs });
          break;
        case 'turn-end':
          this.dispatch({
            type: 'turn-end',
            atMs: event.atMs,
            speechEndedAtMs: event.speechEndedAtMs,
            reason: event.reason,
          });
          // Keep listening for the voice coming back while the countdown runs.
          this.#endpointer = endpointerStart(this.#options.pauseMs, { floorLevels: this.#meter?.recent() ?? [] });
          break;
        default:
          break;
      }
    }
  }

  #beginTurnWords(attempt: number): void {
    const handle = this.#handle;
    const gen = this.#micGen;
    if (handle === null) return;
    void handle.endTurn().then(outcome => {
      if (gen !== this.#micGen) return;
      const atMs = this.#ports.clock.now();
      if (outcome.kind === 'words') this.dispatch({ type: 'turn-words', attempt, atMs, text: outcome.text });
      else if (outcome.kind === 'empty') this.dispatch({ type: 'turn-empty', attempt });
      else this.dispatch({ type: 'turn-failed', attempt, block: outcome.block });
    });
  }

  #resumeListening(): void {
    const handle = this.#handle;
    const gen = this.#micGen;
    if (handle === null) return;
    void handle.resume().then(ok => {
      if (gen === this.#micGen && !ok) this.dispatch({ type: 'blocked', block: 'engine-failed' });
    });
  }

  // — time ———————————————————————————————————————————————————————————————

  #startCountdown(ms: number): void {
    this.#clearCountdown();
    this.#countdownCancel = this.#ports.clock.after(ms, () => {
      this.#countdownCancel = null;
      this.dispatch({ type: 'countdown-done', atMs: this.#ports.clock.now() });
    });
  }

  #clearCountdown(): void {
    this.#countdownCancel?.();
    this.#countdownCancel = null;
  }

  #startTimer(kind: 'settle' | 'idle', ms: number): void {
    this.#timers.get(kind)?.();
    this.#timers.set(
      kind,
      this.#ports.clock.after(ms, () => {
        this.#timers.delete(kind);
        this.dispatch({ type: 'timer', kind, atMs: this.#ports.clock.now() });
      }),
    );
  }

  #clearTimers(): void {
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
  }

  // — the send and the reply ——————————————————————————————————————————————————

  #send(): void {
    void this.#ports.send.send().then(outcome => {
      if (outcome.kind === 'sent') this.dispatch({ type: 'sent', atMs: this.#ports.clock.now() });
      else this.dispatch({ type: 'send-failed' });
    });
  }

  #watchReply(): void {
    this.#stopReply();
    this.#replyCancel = this.#ports.reply.watch(signal => this.dispatch({ type: 'reply', signal: signal.kind }));
  }

  #stopReply(): void {
    this.#replyCancel?.();
    this.#replyCancel = null;
  }

  #speak(): void {
    const speaker = this.#ports.speaker;
    if (speaker === null) this.dispatch({ type: 'speak-done' });
    else speaker.speak(() => this.dispatch({ type: 'speak-done' }));
  }
}
