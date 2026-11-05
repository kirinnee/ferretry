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
 * LOCK GENERATIONS. The one-Live-tab lock is asked for asynchronously, so an answer can arrive after Live
 * ended (End, a refusal, the page leaving, a hidden tab at start-up). Every ask carries the lock generation
 * it was made in; `releaseLocks` advances it, and a grant from an older one is handed straight back, so a
 * late Web Lock can never be held by a Live that is gone.
 *
 * THE REPLY IS ARMED BEFORE THE SEND. The ferret can finish a short turn while the send is still being
 * acknowledged, so the feed takes its baseline and starts listening BEFORE the message goes
 * (`ReplyFeedPort.arm`) and is only attached to the machine once the send is acknowledged.
 *
 * THE ENDPOINTER IS RESTARTED, NOT RESET, after a turn ends: a fresh one is seeded with the room's
 * recent levels, so the voice coming back during the countdown is heard as "speech starts" and the
 * countdown is cancelled — the microphone stays open for exactly that.
 */

import { cueFor } from './earcons.ts';
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
  EarconPort,
  HapticsPort,
  LevelFramesPort,
  LevelMeterHandle,
  MicLockPort,
  ReaderPort,
  ReadWhat,
  ReplyFeedPort,
  ReplyWatch,
  SendPort,
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
  /** Reads a finished turn aloud. Null where nothing can be read: a finished reply then goes straight to listening. */
  readonly reader: ReaderPort | null;
  /** Short tones for listening / sent / reply ready / stopped. Absent: silent. */
  readonly earcons?: EarconPort | null;
  /** A short buzz for sent / reply ready. Absent: none. */
  readonly haptics?: HapticsPort | null;
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
  /** This device cannot reopen the microphone without a tap (an iPhone): Live waits for "Listen" after each reply. */
  readonly tapToListen?: boolean;
  /** Whether the tones are on, asked at each cue so a setting changed mid-Live applies at once. */
  readonly cues?: () => boolean;
  /** Whether the phone buzz is on (asked at each cue). Absent: it follows `cues`, as it did before it had its own switch. */
  readonly buzz?: () => boolean;
  /** Read each finished reply aloud. Asked once, as Live starts; `false` shows the reply and listens again. Absent: read. */
  readonly readAloud?: () => boolean;
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
  /** Advances whenever the locks are released: an answer to an older ask is stale. */
  #lockGen = 0;
  /** The reply feed, armed before the send and attached when it is acknowledged. */
  #armedReply: ReplyWatch | null = null;

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
    this.#unlock();
    this.dispatch({
      type: 'start',
      atMs: this.#ports.clock.now(),
      canSend: this.#options.canSend,
      visible: this.#ports.visibility.visible(),
      graceMs: this.#options.graceMs,
      canRead: this.#ports.reader?.supported === true && this.#options.readAloud?.() !== false,
      tapToListen: this.#options.tapToListen === true,
    });
  }

  /** Inside a tap: allow speech and sound for the rest of the session (iOS and autoplay policies want a gesture). */
  #unlock(): void {
    this.#ports.reader?.unlock();
    this.#ports.earcons?.unlock();
  }

  hold(): void {
    this.dispatch({ type: 'hold' });
  }

  sendNow(): void {
    this.dispatch({ type: 'send-now', atMs: this.#ports.clock.now() });
  }

  resume(): void {
    // A resume is a tap too: the "Listen" after a reply is where an iPhone lets the microphone open again.
    this.#unlock();
    this.dispatch({ type: 'resume' });
  }

  end(): void {
    this.dispatch({ type: 'end' });
  }

  /** Stop reading the reply (tap, Space, Esc, S): Live listens again. */
  skip(): void {
    this.dispatch({ type: 'skip' });
  }

  /** Read the reply again from the start. */
  repeat(): void {
    this.dispatch({ type: 'repeat' });
  }

  /** The person sent a message by hand (not through Live): a reading in progress is stale. */
  outsideSend(): void {
    this.dispatch({ type: 'outside-send', atMs: this.#ports.clock.now() });
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
    this.#ports.reader?.stop();
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
        const before = this.#state;
        const step = liveReduce(before, next);
        this.#state = step.state;
        for (const effect of step.effects) this.#perform(effect);
        this.#cue(before, step.state);
        for (const listener of this.#listeners) listener();
      }
    } finally {
      this.#processing = false;
    }
  }

  #perform(effect: LiveEffect): void {
    switch (effect.type) {
      case 'acquireLocks':
        this.#acquireLocks();
        break;
      case 'releaseLocks':
        this.#releaseLocks();
        break;
      case 'openMic':
        this.#openMic();
        break;
      case 'closeMic':
        this.#closeMic();
        break;
      case 'stopCapture':
        this.#stopCapture();
        break;
      case 'beginTurnWords':
        this.#beginTurnWords(effect.attempt);
        break;
      case 'resumeListening':
        this.#resumeListening();
        break;
      case 'startCountdown':
        this.#startCountdown(effect.ms);
        break;
      case 'cancelCountdown':
        this.#clearCountdown();
        break;
      case 'startTimer':
        this.#startTimer(effect.kind, effect.ms);
        break;
      case 'cancelTimers':
        this.#clearTimers();
        break;
      case 'showWords':
        this.#ports.send.show(effect.text);
        break;
      case 'clearWords':
        this.#ports.send.clear();
        break;
      case 'send':
        this.#send();
        break;
      case 'watchReply':
        this.#watchReply();
        break;
      case 'stopWatchReply':
        this.#stopReply();
        break;
      case 'speak':
        this.#speak(effect.what, effect.id);
        break;
      case 'stopSpeaking':
        this.#ports.reader?.stop();
        break;
      case 'recordTurn':
        this.#options.onTurn?.(effect.numbers);
        break;
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
    const gen = this.#lockGen;
    void this.#ports.micLock.acquire().then(granted => {
      if (gen !== this.#lockGen) {
        // Live ended (or was released) while the lock was being asked for: a grant now is nobody's, unless a
        // newer ask has been made since — that one owns the adapter and must not be released from under it.
        if (granted && !this.#lockAsked && !this.#lockHeld) this.#ports.micLock.release();
        return;
      }
      this.#lockAsked = false;
      this.#lockHeld = granted;
      this.dispatch({ type: 'locks', granted });
    });
  }

  #releaseLocks(): void {
    this.#lockGen += 1;
    this.#lockAsked = false;
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

  /**
   * Stop hearing NOW: no more level frames, no endpointer, no bars. The take stays open (its pending words are
   * still coming — a stop never loses what was said), and the machine closes it when they land.
   */
  #stopCapture(): void {
    this.#endpointer = null;
    this.#levels = [];
    const meter = this.#meter;
    this.#meter = null;
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
    // The feed is armed (baseline taken, listening) BEFORE the message goes: a fast turn can finish while the
    // send is still being acknowledged. The reader's baseline is taken at the same moment.
    this.#armedReply?.cancel();
    const armed = this.#arm();
    this.#armedReply = armed;
    void this.#ports.send.send().then(outcome => {
      if (outcome.kind === 'sent') this.dispatch({ type: 'sent', atMs: this.#ports.clock.now() });
      else {
        if (this.#armedReply === armed) this.#armedReply = null;
        armed.cancel();
        this.dispatch({ type: 'send-failed' });
      }
    });
  }

  /** Arm the feed and remember what the page holds, as the message goes. */
  #arm(): ReplyWatch {
    this.#ports.reader?.mark();
    return this.#ports.reply.arm();
  }

  #watchReply(): void {
    const armed = this.#armedReply ?? this.#arm();
    this.#armedReply = null;
    this.#replyCancel?.();
    this.#replyCancel = armed.attach(signal => this.dispatch({ type: 'reply', signal: signal.kind }));
  }

  #stopReply(): void {
    this.#replyCancel?.();
    this.#replyCancel = null;
    this.#armedReply?.cancel();
    this.#armedReply = null;
  }

  // — reading and cues ——————————————————————————————————————————————————————

  #speak(what: ReadWhat, id: number): void {
    const reader = this.#ports.reader;
    if (reader === null) {
      this.dispatch({ type: 'speak-done', id, end: 'unavailable' });
      return;
    }
    // `onEnd` may come at once (a fake, a refusal) or much later: either way it is queued behind the event in hand.
    reader.read(what, end => this.dispatch({ type: 'speak-done', id, end }));
  }

  /** The tone and the buzz this event earned (`earcons.ts`), if the person has them on. */
  #cue(before: LiveState, after: LiveState): void {
    if (before.phase === after.phase) return;
    const cue = cueFor(before, after);
    if (cue.earcon === null && cue.haptic === null) return;
    const tones = this.#options.cues?.() !== false;
    const buzz = (this.#options.buzz ?? this.#options.cues)?.() !== false;
    if (cue.earcon !== null && tones) this.#ports.earcons?.play(cue.earcon);
    if (cue.haptic !== null && buzz) this.#ports.haptics?.pulse(cue.haptic);
  }
}
