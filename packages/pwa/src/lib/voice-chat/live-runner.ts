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
 * ONE REVOCABLE SEND PATH. Live sends through exactly one door: a `SendTicket` carrying the words that were on
 * screen when the machine approved the send. The composer sends them a render later and calls `commit()` the
 * instant before it does; until then the ticket is revocable. Hold, typing (synchronously, on the input event),
 * a hidden tab, End, a refused lock, the page leaving — each revokes it (Hold, typing and hidden first send the machine
 * `send-withdrawn`), so a queued send can never go after a stop, never go as different words, and never go twice.
 * The person's own Send (`personSent`) is the same path from the other side: the press is adopted as the send in
 * flight and retires the attempt, so the countdown and the pending decode cannot send it again.
 *
 * THE REPLY IS ARMED BEFORE THE SEND. The ferret can finish a short turn while the send is still being
 * acknowledged, so the feed takes its baseline and starts listening BEFORE the message goes
 * (`ReplyFeedPort.arm`) and is only attached to the machine once the send is acknowledged.
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
  ReplyWatch,
  SendPort,
  SendTicket,
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

/** One approved send. Revocable until the composer commits; see the file header. */
class LiveSendTicket implements SendTicket {
  readonly text: string;
  readonly #visible: () => boolean;
  #revoked = false;
  #committed: boolean;

  constructor(text: string, visible: () => boolean, committed: boolean) {
    this.text = text;
    this.#visible = visible;
    this.#committed = committed;
  }

  get revoked(): boolean {
    return this.#revoked;
  }

  /** The send is on its way: a stop can no longer take it back. */
  get committed(): boolean {
    return this.#committed;
  }

  revoke(): void {
    this.#revoked = true;
  }

  commit(): boolean {
    if (this.#revoked || !this.#visible()) return false;
    this.#committed = true;
    return true;
  }
}

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
  /** The send in flight (Live's own, or the person's adopted press); null when none. */
  #ticket: LiveSendTicket | null = null;

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
    this.#unwatchVisibility ??= this.#ports.visibility.watch(visible => {
      if (!visible) this.#withdrawQueuedSend();
      this.dispatch({ type: 'visibility', visible });
    });
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
    this.#withdrawQueuedSend();
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

  /** The person edited the composer: auto-send pauses, and a send queued but not yet started is taken back. */
  typing(): void {
    this.#withdrawQueuedSend();
    this.dispatch({ type: 'typing' });
  }

  /**
   * The person pressed the composer's own Send and `outcome` is that press (true: it went). Whatever Live was doing
   * about the turn is retired — countdown, timers, the take and its pending decode, the microphone — and the press
   * becomes the send in flight: `sent` starts the working/reply-watch path, a failure is On hold with the words kept.
   * Live's own queued send, if there was one, gives way: the box can only be sent once.
   */
  personSent(outcome: Promise<boolean>): void {
    this.dispatch({ type: 'person-send', atMs: this.#ports.clock.now() });
    const { phase, sendInFlight } = this.#state;
    if (phase !== 'sending' || !sendInFlight) return;
    this.#ticket?.revoke();
    this.#armedReply ??= this.#ports.reply.arm();
    const ticket = new LiveSendTicket(this.#ports.send.shown(), () => true, true);
    this.#ticket = ticket;
    void outcome.then(sent => this.#sendDone(ticket, sent));
  }

  /** Close everything for good (the page is leaving). No notice, no events afterwards. */
  dispose(): void {
    this.#disposed = true;
    this.#queue.length = 0;
    this.#unwatchVisibility?.();
    this.#unwatchVisibility = null;
    this.#revokeTicket();
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
        // A send is revocable only while the machine still has it in flight: once it has ended (End, a refused lock,
        // the ferret stopping, a failure) the ticket is dead, whatever the composer is still about to do with it.
        if (!(step.state.phase === 'sending' && step.state.sendInFlight)) this.#revokeTicket();
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
        this.#speak();
        break;
      case 'stopSpeaking':
        this.#ports.speaker?.stop();
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
    // A new take never writes over the words an earlier one left in the box (a Hold, a pause): they are final now.
    this.#ports.send.seal();
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
    // The take's own recording closes too: a decode still pending must not keep the microphone open.
    this.#handle?.stopRecording();
  }

  /** The message box holds text Live did not put there: an unfinished typed instruction never rides along with a voice send. */
  #typed(): boolean {
    return this.#ports.send.typed().trim() !== '';
  }

  /** The engine ended the take by itself: its own limit, or the browser gave up. */
  #takeEnded(): void {
    const { phase } = this.#state;
    const now = this.#ports.clock.now();
    if (phase === 'hearing')
      this.dispatch({ type: 'turn-end', atMs: now, speechEndedAtMs: now, reason: 'max-turn', typed: this.#typed() });
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
          this.dispatch({ type: 'speech-cancel', atMs: event.atMs, typed: this.#typed() });
          break;
        case 'turn-end':
          this.dispatch({
            type: 'turn-end',
            atMs: event.atMs,
            speechEndedAtMs: event.speechEndedAtMs,
            reason: event.reason,
            typed: this.#typed(),
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
    // send is still being acknowledged.
    this.#armedReply?.cancel();
    this.#armedReply = this.#ports.reply.arm();
    // What is on screen at this moment is what is approved; the composer sends exactly that or nothing.
    const ticket = new LiveSendTicket(this.#ports.send.shown(), () => this.#ports.visibility.visible(), false);
    this.#ticket = ticket;
    void this.#ports.send.send(ticket).then(outcome => this.#sendDone(ticket, outcome.kind === 'sent'));
  }

  /** The send's answer. Only the CURRENT send speaks: a taken-back or replaced one is silent. */
  #sendDone(ticket: LiveSendTicket, sent: boolean): void {
    if (this.#ticket !== ticket) return;
    this.#ticket = null;
    if (sent) {
      this.dispatch({ type: 'sent', atMs: this.#ports.clock.now() });
      return;
    }
    this.#armedReply?.cancel();
    this.#armedReply = null;
    this.dispatch({ type: 'send-failed' });
  }

  /** Revoke the ticket of a send that is still in flight. Idempotent. */
  #revokeTicket(): void {
    this.#ticket?.revoke();
    this.#ticket = null;
  }

  /**
   * A stop arrived while Live's send was approved but the composer had not started it: take it back, so the stop
   * lands as it would in the countdown. A send already started (committed) is on the wire and stands.
   */
  #withdrawQueuedSend(): void {
    const ticket = this.#ticket;
    if (ticket === null || ticket.committed) return;
    this.#revokeTicket();
    this.#armedReply?.cancel();
    this.#armedReply = null;
    this.dispatch({ type: 'send-withdrawn' });
  }

  #watchReply(): void {
    const armed = this.#armedReply ?? this.#ports.reply.arm();
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

  #speak(): void {
    const speaker = this.#ports.speaker;
    if (speaker === null) this.dispatch({ type: 'speak-done' });
    else speaker.speak(() => this.dispatch({ type: 'speak-done' }));
  }
}
