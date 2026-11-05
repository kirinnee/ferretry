/**
 * Fake ports for the Live voice composition tests (the hook, the control, the composer): the real
 * machine and runner run over these, and a test drives them by hand — a tap is `start()`, a turn is
 * `hear()`, time is `advance()`. Nothing here touches a microphone, a timer or the network.
 */

import type { LiveRunnerPorts } from '../../src/lib/voice-chat/live-runner.ts';
import type {
  LevelMeterHandle,
  ReadEnd,
  ReadWhat,
  ReplySignal,
  SendOutcome,
  SendTicket,
  TakeHandle,
  TakeListener,
  TakeOutcome,
} from '../../src/lib/voice-chat/ports.ts';
import type { LevelFrame } from '../../src/lib/voice-chat/turn-endpointer.ts';

export interface FakeLive {
  readonly ports: LiveRunnerPorts;
  readonly takes: { cancelled: boolean; stopped: boolean; endTurns: number }[];
  readonly listeners: TakeListener[];
  readonly shown: string[];
  readonly sends: number[];
  /** The exact words each send carried (`SendTicket.text`), in order. */
  readonly sentTexts: string[];
  /** The tickets the runner handed to `send`, newest last. */
  readonly tickets: SendTicket[];
  /** While set, `send` waits for it before it commits (the composer's render between approval and send). */
  readonly sendGate: { current: Promise<void> | null };
  readonly log: string[];
  readonly lock: { granted: boolean };
  /** The text in the box that Live did not put there (a person typed it): what `SendPort.typed` answers. */
  readonly typed: { current: string };
  /** Advance the fake clock, firing due timers. */
  advance(ms: number): void;
  /** `ms` of speech (or quiet) as 20 ms frames. */
  hear(rms: number, ms: number): void;
  signal(signal: ReplySignal): void;
  setVisible(visible: boolean): void;
  outcome: { current: TakeOutcome };
  /** How long `endTurn` takes to answer, in fake milliseconds: the engine's remaining decode time. */
  readonly decodeMs: { current: number };
  sendResult: { current: SendOutcome };
  /** The fake reader's record (present when `reader` was asked for). */
  readonly reader: {
    readonly reads: ReadWhat[];
    readonly stops: { count: number };
    readonly marks: { count: number };
    /** End the reading in progress. */
    end(end: ReadEnd): void;
  };
}

export const fakeLive = (options: { reader?: boolean } = {}): FakeLive => {
  const reads: ReadWhat[] = [];
  const stops = { count: 0 };
  const marks = { count: 0 };
  let endReading: (end: ReadEnd) => void = () => undefined;
  let now = 0;
  const pending: { at: number; run: () => void; live: boolean }[] = [];
  const takes: FakeLive['takes'] = [];
  const listeners: TakeListener[] = [];
  const shown: string[] = [];
  const sends: number[] = [];
  const sentTexts: string[] = [];
  const tickets: SendTicket[] = [];
  const sendGate: FakeLive['sendGate'] = { current: null };
  const log: string[] = [];
  const lock = { granted: true };
  const typed = { current: '' };
  const outcome = {
    current: { kind: 'words', text: 'Fix the bug.', raw: 'fix the bug', cleaned: true } as TakeOutcome,
  };
  const decodeMs = { current: 0 };
  const sendResult = { current: { kind: 'sent', sentAtMs: 0 } as SendOutcome };
  let onFrame: (frame: LevelFrame) => void = () => undefined;
  let reply: ((signal: ReplySignal) => void) | null = null;
  let visible = true;
  const visibility = new Set<(visible: boolean) => void>();

  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = pending.filter(entry => entry.live && entry.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      now = due.at;
      due.run();
    }
    now = target;
  };
  const meter: LevelMeterHandle = { recent: () => [0.001], release: () => void log.push('meter.release') };

  const ports: LiveRunnerPorts = {
    take: {
      start: listener => {
        const take = { cancelled: false, stopped: false, endTurns: 0 };
        takes.push(take);
        listeners.push(listener);
        log.push('take.start');
        const handle: TakeHandle = {
          endTurn: async () => {
            take.endTurns += 1;
            if (decodeMs.current > 0) await new Promise<void>(resolve => ports.clock.after(decodeMs.current, resolve));
            return outcome.current;
          },
          resume: async () => true,
          stopRecording: () => {
            take.stopped = true;
          },
          cancel: () => {
            take.cancelled = true;
          },
        };
        return handle;
      },
    },
    levels: {
      open: async frameHandler => {
        onFrame = frameHandler;
        return meter;
      },
    },
    send: {
      show: text => void shown.push(text),
      clear: () => void shown.push('<cleared>'),
      seal: () => void log.push('seal'),
      shown: () => shown.at(-1) ?? '',
      typed: () => typed.current,
      // The composer: waits for its render, then commits the ticket just before it sends — or sends nothing.
      send: async ticket => {
        tickets.push(ticket);
        if (sendGate.current !== null) await sendGate.current;
        if (!ticket.commit()) return { kind: 'failed', reason: 'revoked' };
        sends.push(now);
        sentTexts.push(ticket.text);
        return sendResult.current;
      },
    },
    reply: {
      arm: () => ({
        attach: listener => {
          reply = listener;
          return () => {
            reply = null;
          };
        },
        cancel: () => {
          reply = null;
        },
      }),
    },
    reader: options.reader
      ? {
          supported: true,
          unlock: () => undefined,
          mark: () => {
            marks.count += 1;
          },
          read: (what, onEnd) => {
            reads.push(what);
            endReading = onEnd;
          },
          stop: () => {
            stops.count += 1;
          },
        }
      : null,
    wakeLock: { acquire: async () => true, release: () => undefined },
    visibility: {
      visible: () => visible,
      watch: listener => {
        visibility.add(listener);
        return () => void visibility.delete(listener);
      },
    },
    micLock: { acquire: async () => lock.granted, release: () => void log.push('lock.release') },
    clock: {
      now: () => now,
      after: (ms, run) => {
        const entry = { at: now + ms, run, live: true };
        pending.push(entry);
        return () => {
          entry.live = false;
        };
      },
    },
  };

  return {
    ports,
    takes,
    listeners,
    shown,
    sends,
    sentTexts,
    tickets,
    sendGate,
    log,
    lock,
    typed,
    advance,
    hear: (rms, ms) => {
      for (let spent = 0; spent < ms; spent += 20) {
        advance(20);
        onFrame({ atMs: now, rms });
      }
    },
    signal: signal => reply?.(signal),
    setVisible: next => {
      visible = next;
      for (const listener of visibility) listener(next);
    },
    outcome,
    decodeMs,
    sendResult,
    reader: { reads, stops, marks, end: end => endReading(end) },
  };
};
