/**
 * THE COMPOSER'S SHARED DRAFT: the same words on every one of the owner's devices with this session open.
 *
 * The composer keeps its own `draft` state exactly as before; this hook only keeps that state in step.
 * Every change the person makes is turned into an edit and sent; every edit another device makes is
 * applied here and handed back through `setText`, with the edit itself (`onRemote`) so the composer can
 * keep the caret where the person left it. A send empties the draft everywhere (`sent`).
 *
 * WITHOUT A STREAM IT IS THE COMPOSER IT WAS. No store, no carrier, a daemon that refuses: nothing is
 * shown, nothing is lost, and the draft stays this device's own (still saved locally by the composer)
 * until a stream opens — the first snapshot then reconciles the two (`lib/shared-draft-sync.ts`).
 *
 * The stream reconnects on its own with a growing wait, and a reconnect asks only for what it missed.
 */
import type { SharedDraftClientFrame, SharedDraftServerFrame, TextOp } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import type { DaemonStreamOpener } from '../lib/event-transport.ts';
import { useDaemonStreamOpener } from '../lib/store.tsx';
import { openSharedDraftStream, type SharedDraftStreamLink } from '../lib/shared-draft-stream.ts';
import {
  applyDisconnect,
  applyLocalText,
  applyServerFrame,
  initialSharedDraftState,
  type SharedDraftIdSource,
  type SharedDraftStep,
  type SharedDraftSyncState,
} from '../lib/shared-draft-sync.ts';

/** How long a device's "typing" lasts after its last report, before the hint lets it go. */
const SHARED_DRAFT_TYPING_SHOWN_MS = 5_000;
/** How long after the last keystroke this device says it has stopped typing. */
const SHARED_DRAFT_TYPING_IDLE_MS = 3_000;
/** At most one "I am typing" report per this long: the daemon drops anything past four a second anyway. */
const SHARED_DRAFT_TYPING_REPORT_MS = 1_000;
/** The longest wait between reconnect attempts. */
const SHARED_DRAFT_RECONNECT_MAX_MS = 30_000;

/** Another of the owner's devices with this composer open. */
export interface SharedDraftPeer {
  readonly peer: string;
  readonly device: string;
  readonly typing: boolean;
  /** When it last said anything, in this device's clock. */
  readonly seenAt: number;
}

/** Timers and the clock, injected so a test drives them. */
export interface SharedDraftTimers {
  readonly now: () => number;
  readonly after: (milliseconds: number, action: () => void) => () => void;
}

const browserTimers: SharedDraftTimers = {
  now: () => Date.now(),
  after: (milliseconds, action) => {
    const timer = setTimeout(action, milliseconds);
    return () => clearTimeout(timer);
  },
};

export interface UseSharedDraftInput {
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** The composer's text, as it renders now. */
  readonly text: string;
  /** Puts another device's words into the composer. */
  readonly setText: (text: string) => void;
  /** Another device's edit has just changed the text to `text`, by `op`: move the caret past it. */
  readonly onRemote?: (op: TextOp, text: string) => void;
  /** Off: the composer is its own, as it was before drafts were shared. */
  readonly enabled?: boolean;
  /** Injected in tests; the store's carrier otherwise. */
  readonly open?: DaemonStreamOpener;
  readonly timers?: SharedDraftTimers;
  readonly ids?: SharedDraftIdSource;
}

export interface SharedDraft {
  /** The owner's other devices that are typing into this draft right now. */
  readonly typing: readonly SharedDraftPeer[];
  /** Words this device had that could not be merged, waiting for the person to restore or dismiss. */
  readonly conflict: string | null;
  readonly restoreConflict: () => void;
  readonly dismissConflict: () => void;
  /** The message was sent: empty the draft on every device. */
  readonly sent: () => void;
  /** Whether a stream is open right now. */
  readonly live: boolean;
}

const randomId: SharedDraftIdSource = () => crypto.randomUUID();

export function useSharedDraft({
  daemon,
  scope,
  text,
  setText,
  onRemote,
  enabled = true,
  open,
  timers = browserTimers,
  ids = randomId,
}: UseSharedDraftInput): SharedDraft {
  const storeOpener = useDaemonStreamOpener();
  const opener = open ?? storeOpener;
  const state = useRef<SharedDraftSyncState>(initialSharedDraftState(text));
  const link = useRef<SharedDraftStreamLink | null>(null);
  /**
   * Frames made while a stream is opening but its handle has not been handed back yet — the daemon can
   * answer before the open settles. Sent the moment it is; dropped if the stream dies first (an edit among
   * them is then resent by the next stream, see `applyDisconnect`).
   */
  const queued = useRef<SharedDraftClientFrame[]>([]);
  const textNow = useRef(text);
  textNow.current = text;
  const callbacks = useRef({ setText, onRemote });
  callbacks.current = { setText, onRemote };
  const [peers, setPeers] = useState<ReadonlyMap<string, SharedDraftPeer>>(new Map());
  const [conflict, setConflict] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  /** Bumped by the timer that lets a stale "typing" go, so the hint re-renders without it. */
  const [, setTick] = useState(0);

  const run = useCallback((step: SharedDraftStep): void => {
    state.current = step.state;
    for (const frame of step.send) {
      if (link.current === null) queued.current.push(frame);
      else link.current.send(frame);
    }
    if (step.conflict !== undefined) setConflict(step.conflict);
    if (step.state.text !== textNow.current) {
      textNow.current = step.state.text;
      if (step.remote !== undefined) callbacks.current.onRemote?.(step.remote, step.state.text);
      callbacks.current.setText(step.state.text);
    }
    // A refusal: start again from the whole draft. Closing schedules the reconnect.
    if (step.resync === true) link.current?.close();
  }, []);

  // The stream: opened per session, reopened whenever it ends, until this composer goes.
  useEffect(() => {
    if (!enabled) return;
    state.current = initialSharedDraftState(textNow.current);
    setConflict(null);
    let stopped = false;
    let attempt = 0;
    let cancelRetry: (() => void) | undefined;
    const handle = (frame: SharedDraftServerFrame): void => {
      if (frame.kind === 'presence') {
        const seen: SharedDraftPeer = {
          peer: frame.peer,
          device: frame.device,
          typing: frame.typing,
          seenAt: timers.now(),
        };
        setPeers(current => new Map(current).set(frame.peer, seen));
        if (frame.typing) timers.after(SHARED_DRAFT_TYPING_SHOWN_MS + 50, () => setTick(tick => tick + 1));
        return;
      }
      if (frame.kind === 'left') {
        setPeers(current => {
          const next = new Map(current);
          next.delete(frame.peer);
          return next;
        });
        return;
      }
      if (frame.kind === 'ready' || frame.kind === 'snapshot') attempt = 0;
      run(applyServerFrame(state.current, frame, ids));
    };
    const retry = (): void => {
      if (stopped) return;
      const wait = Math.min(1_000 * 2 ** attempt, SHARED_DRAFT_RECONNECT_MAX_MS);
      attempt += 1;
      cancelRetry = timers.after(wait, () => void connect());
    };
    const connect = async (): Promise<void> => {
      const current = state.current;
      try {
        const opened = await openSharedDraftStream(
          opener,
          daemon,
          scope,
          current.resyncing ? undefined : current.position,
          {
            onFrame: handle,
            onClosed: () => {
              if (link.current === opened) link.current = null;
              queued.current = [];
              state.current = applyDisconnect(state.current);
              setLive(false);
              setPeers(new Map());
              retry();
            },
          },
        );
        if (stopped) {
          opened.close();
          return;
        }
        link.current = opened;
        for (const frame of queued.current.splice(0)) opened.send(frame);
        setLive(true);
      } catch {
        queued.current = [];
        state.current = applyDisconnect(state.current);
        retry();
      }
    };
    void connect();
    return () => {
      stopped = true;
      cancelRetry?.();
      const leaving = link.current;
      link.current = null;
      leaving?.close();
      setLive(false);
      setPeers(new Map());
    };
    // `scope` is memoised by the composer, and `timers` and `ids` are fixed for its life, so this runs
    // once per session the composer shows.
  }, [daemon, enabled, ids, opener, run, scope, timers]);

  // The person's own changes, however they were made, become edits.
  const typingReported = useRef(0);
  const stopTyping = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!enabled || text === state.current.text) return;
    run(applyLocalText(state.current, text, ids));
    const now = timers.now();
    if (now - typingReported.current >= SHARED_DRAFT_TYPING_REPORT_MS) {
      typingReported.current = now;
      link.current?.send({ kind: 'presence', typing: true });
    }
    stopTyping.current?.();
    stopTyping.current = timers.after(SHARED_DRAFT_TYPING_IDLE_MS, () => {
      typingReported.current = 0;
      link.current?.send({ kind: 'presence', typing: false });
    });
  }, [enabled, ids, run, text, timers]);
  useEffect(() => () => stopTyping.current?.(), []);

  const sent = useCallback((): void => {
    if (!enabled) return;
    stopTyping.current?.();
    run(applyLocalText(state.current, '', ids, true));
    link.current?.send({ kind: 'presence', typing: false });
  }, [enabled, ids, run]);

  const restoreConflict = useCallback((): void => {
    const words = conflict;
    if (words === null) return;
    setConflict(null);
    const current = textNow.current;
    // Added to what is there, never in place of it: what is there is somebody's too.
    callbacks.current.setText(current.trim() === '' ? words : `${current}\n${words}`);
  }, [conflict]);
  const dismissConflict = useCallback((): void => setConflict(null), []);

  // Read fresh each render: the tick above re-renders once a report has gone stale.
  const now = timers.now();
  const typing = [...peers.values()].filter(peer => peer.typing && now - peer.seenAt < SHARED_DRAFT_TYPING_SHOWN_MS);

  return { typing, conflict, restoreConflict, dismissConflict, sent, live };
}

/** "also typing on Kirin's iPhone", "… on Kirin's iPhone and Desktop": the hint's words, or nothing. */
export const sharedDraftTypingHint = (typing: readonly SharedDraftPeer[]): string | null => {
  const devices = [...new Set(typing.map(peer => peer.device))];
  if (devices.length === 0) return null;
  if (devices.length === 1) return `also typing on ${devices[0]}`;
  return `also typing on ${devices.slice(0, -1).join(', ')} and ${devices.at(-1)}`;
};
