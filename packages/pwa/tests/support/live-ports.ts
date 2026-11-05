/**
 * Fake ports for the Live voice composition tests (the hook, the control, the composer): the real
 * machine and runner run over these, and a test drives them by hand — a tap is `start()`, a turn is
 * `hear()`, time is `advance()`. Nothing here touches a microphone, a timer or the network.
 */

import type { LiveRunnerPorts } from '../../src/lib/voice-chat/live-runner.ts';
import type {
  LevelMeterHandle,
  ReplySignal,
  SendOutcome,
  TakeHandle,
  TakeListener,
  TakeOutcome,
} from '../../src/lib/voice-chat/ports.ts';
import type { LevelFrame } from '../../src/lib/voice-chat/turn-endpointer.ts';

export interface FakeLive {
  readonly ports: LiveRunnerPorts;
  readonly takes: { cancelled: boolean; endTurns: number }[];
  readonly listeners: TakeListener[];
  readonly shown: string[];
  readonly sends: number[];
  readonly log: string[];
  readonly lock: { granted: boolean };
  /** Advance the fake clock, firing due timers. */
  advance(ms: number): void;
  /** `ms` of speech (or quiet) as 20 ms frames. */
  hear(rms: number, ms: number): void;
  signal(signal: ReplySignal): void;
  setVisible(visible: boolean): void;
  outcome: { current: TakeOutcome };
  sendResult: { current: SendOutcome };
}

export const fakeLive = (): FakeLive => {
  let now = 0;
  const pending: { at: number; run: () => void; live: boolean }[] = [];
  const takes: FakeLive['takes'] = [];
  const listeners: TakeListener[] = [];
  const shown: string[] = [];
  const sends: number[] = [];
  const log: string[] = [];
  const lock = { granted: true };
  const outcome = {
    current: { kind: 'words', text: 'Fix the bug.', raw: 'fix the bug', cleaned: true } as TakeOutcome,
  };
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
        const take = { cancelled: false, endTurns: 0 };
        takes.push(take);
        listeners.push(listener);
        log.push('take.start');
        const handle: TakeHandle = {
          endTurn: async () => {
            take.endTurns += 1;
            return outcome.current;
          },
          resume: async () => true,
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
      shown: () => shown.at(-1) ?? '',
      send: async () => {
        sends.push(now);
        return sendResult.current;
      },
    },
    reply: {
      watch: listener => {
        reply = listener;
        return () => {
          reply = null;
        };
      },
    },
    speaker: null,
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
    log,
    lock,
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
    sendResult,
  };
};
