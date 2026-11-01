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
import {
  applyTextOp,
  diffToTextOp,
  textOpBaseLength,
  SHARED_DRAFT_STREAM_RESYNC_CLOSE,
  type SharedDraftClientFrame,
  type SharedDraftSent,
  transformTextOps,
  type SharedDraftServerFrame,
  type TextOp,
} from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import type { DaemonStreamOpener } from '../lib/event-transport.ts';
import { type DaemonDraftStore, documentRestoreStore } from '../lib/drafts.ts';
import { useDaemonStreamOpener } from '../lib/store.tsx';
import { openSharedDraftStream, type SharedDraftStreamLink } from '../lib/shared-draft-stream.ts';
import {
  applyDisconnect,
  applyLocalText,
  applyResync,
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

/** One press of send, as `useSharedDraft` remembers it. Opaque to the composer. */
export interface SharedDraftSendMark {
  readonly scope: string;
}

/** How long a send waits for this device's last keystroke to be answered, to carry its clear. Never longer. */
const SHARED_DRAFT_SEND_CLEAR_WAIT_MS = 1_000;

/** Separate copies of words waiting to be restored, per session: each one a whole draft at most. */
const RESTORE_COPIES = 5;
const restoreScope = (scope: DaemonSessionScope, index: number): DaemonSessionScope => ({
  ...scope,
  sessionId: `${scope.sessionId}\u0000restore-${index}`,
});
const loadRestore = (store: Pick<DaemonDraftStore, 'load'>, scope: DaemonSessionScope): string[] =>
  Array.from({ length: RESTORE_COPIES }, (_, index) => store.load(restoreScope(scope, index))).filter(
    words => words !== '',
  );
const clearRestore = (store: Pick<DaemonDraftStore, 'clear'>, scope: DaemonSessionScope): void => {
  for (let index = 0; index < RESTORE_COPIES; index += 1) store.clear(restoreScope(scope, index));
};
/**
 * Keeps `words` as one more copy, never by growing an existing one: a copy is bounded like a draft, and a
 * store that drops an oversized entry would drop the words already kept. Past {@link RESTORE_COPIES} the
 * oldest goes.
 */
const keepRestore = (
  store: Pick<DaemonDraftStore, 'load' | 'save' | 'clear'>,
  scope: DaemonSessionScope,
  words: string,
): string[] => {
  const copies = loadRestore(store, scope);
  if (copies.includes(words)) return copies;
  const next = [...copies, words].slice(-RESTORE_COPIES);
  clearRestore(store, scope);
  for (const [index, copy] of next.entries()) store.save(restoreScope(scope, index), copy);
  return next;
};
const joinRestore = (copies: readonly string[]): string | null => (copies.length === 0 ? null : copies.join('\n'));

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
  /** Where words waiting to be restored are kept across reloads; the browser's by default. */
  readonly restoreStore?: Pick<DaemonDraftStore, 'load' | 'save' | 'clear'>;
}

export interface SharedDraft {
  /** The owner's other devices that are typing into this draft right now. */
  readonly typing: readonly SharedDraftPeer[];
  /** Words this device had that could not be merged, waiting for the person to restore or dismiss. */
  readonly conflict: string | null;
  readonly restoreConflict: () => void;
  readonly dismissConflict: () => void;
  /** The person pressed send: remembers what is being sent, against everything typed until it lands. */
  readonly markSend: () => SharedDraftSendMark;
  /**
   * What the send should carry so the daemon takes its words out once it lands. Waits — at most `waitMs`,
   * and never across a session switch — for this device's last edit to be answered, since a clear "at
   * revision n" must name exactly the words the person sees; answers nothing when it cannot, and the send
   * goes without it, unblocked.
   */
  readonly sendClear: (
    mark: SharedDraftSendMark,
    waitMs?: number,
  ) => SharedDraftSent | undefined | Promise<SharedDraftSent | undefined>;
  /**
   * The marked send went: takes EXACTLY its words out — not whatever the box holds now, which may be words
   * typed since, here or on another device — and answers the text left. `null` when the composer has moved
   * to another session meanwhile: that session's draft is not this send's to touch.
   */
  readonly sent: (mark: SharedDraftSendMark, requestId?: string) => string | null;
  /** The marked send did not go: forget the mark. */
  readonly abandonSend: (mark: SharedDraftSendMark) => void;
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
  restoreStore = documentRestoreStore,
}: UseSharedDraftInput): SharedDraft {
  const storeOpener = useDaemonStreamOpener();
  const scopeKey = daemonSessionKey(scope);
  /** The session showing NOW: a send completes long after the render that pressed it. */
  const scopeNow = useRef(scopeKey);
  scopeNow.current = scopeKey;
  const scopeObjectNow = useRef(scope);
  scopeObjectNow.current = scope;
  const restoreNow = useRef(restoreStore);
  restoreNow.current = restoreStore;
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

  /**
   * The words of a send in progress, as the edit that removes them, kept in step with every change made
   * since the press — here or on another device — so that when the send lands it removes those words and
   * nothing typed after them.
   */
  const marked = useRef<{
    readonly mark: SharedDraftSendMark;
    /** `undefined` once it could not follow the text (a snapshot replaced it): the words are then not known. */
    readonly op: TextOp | undefined;
    /** The words as they were at the press. */
    readonly text: string;
    /** Whether the send carried its own clear, which the daemon applies. */
    carried: boolean;
  } | null>(null);
  /** Moves the mark past one change. Total: a change it cannot follow loses the words, never throws. */
  const carry = useCallback((change: TextOp): void => {
    const current = marked.current;
    if (current === null || current.op === undefined) return;
    // Two edits of the same text always transform; anything else means the words can no longer be followed.
    const same = textOpBaseLength(change) === textOpBaseLength(current.op);
    marked.current = { ...current, op: same ? transformTextOps(change, current.op)[1] : undefined };
  }, []);
  /** Edits answered, and everything waiting for that. */
  const settled = useRef(new Set<() => void>());

  const run = useCallback(
    (step: SharedDraftStep, local = false): void => {
      if (step.remote !== undefined) carry(step.remote);
      // The text replaced wholesale (a snapshot): no edit says how the marked words moved, so they are lost.
      else if (!local && step.state.text !== state.current.text && marked.current !== null)
        marked.current = { ...marked.current, op: undefined };
      state.current = step.state;
      for (const frame of step.send) {
        if (link.current === null) queued.current.push(frame);
        else link.current.send(frame);
      }
      if (step.conflict !== undefined) {
        // Kept apart from the draft BEFORE the draft is replaced, and added to anything already waiting —
        // a second conflict never costs the words of the first.
        setConflict(joinRestore(keepRestore(restoreNow.current, scopeObjectNow.current, step.conflict)));
      }
      if (step.state.text !== textNow.current) {
        textNow.current = step.state.text;
        if (step.remote !== undefined) callbacks.current.onRemote?.(step.remote, step.state.text);
        callbacks.current.setText(step.state.text);
      }
      // A refusal: start again from the whole draft. Closing schedules the reconnect.
      if (step.resync === true) link.current?.close();
      if (step.state.inflight === undefined && step.state.buffer === undefined)
        for (const listener of [...settled.current]) listener();
    },
    [carry],
  );

  // The stream: opened per session, reopened whenever it ends, until this composer goes.
  useEffect(() => {
    if (!enabled) return;
    state.current = initialSharedDraftState(textNow.current);
    // A send pressed in the session before is not this session's: its mark goes with it, and a send
    // waiting to name its clear stops waiting now.
    marked.current = null;
    for (const listener of [...settled.current]) listener();
    // Words still waiting from an earlier visit, a reload, or another session's switch come back with it.
    setConflict(joinRestore(loadRestore(restoreNow.current, scope)));
    let stopped = false;
    let attempt = 0;
    let cancelRetry: (() => void) | undefined;
    /**
     * EVERY CALLBACK OF THIS RUN IS FENCED BY `stopped`. The refs above are shared by every session the
     * composer shows, and a stream opened for the session the person just LEFT can still answer — even
     * before its open settles. Unfenced, its snapshot would land in the next session's composer and be
     * saved as that session's draft: one session's words sent to another session's agent.
     */
    const handle = (frame: SharedDraftServerFrame): void => {
      if (stopped) return;
      // Defence in depth: a draft that names another session is never this composer's.
      if (frame.kind === 'snapshot' && frame.snapshot.sessionId !== scope.sessionId) {
        link.current?.close();
        return;
      }
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
            onClosed: (code: number) => {
              if (stopped) return;
              if (link.current === opened) link.current = null;
              queued.current = [];
              // A frame no record could carry: the next stream starts from the whole draft, in parts.
              state.current =
                code === SHARED_DRAFT_STREAM_RESYNC_CLOSE ? applyResync(state.current) : applyDisconnect(state.current);
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
        if (stopped) return;
        queued.current = [];
        state.current = applyDisconnect(state.current);
        retry();
      }
    };
    void connect();
    return () => {
      stopped = true;
      cancelRetry?.();
      // Frames this session's composer queued are this session's, never the next one's.
      queued.current = [];
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
    carry(diffToTextOp(state.current.text, text));
    run(applyLocalText(state.current, text, ids), true);
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
  }, [enabled, ids, run, text, timers, carry]);
  useEffect(() => () => stopTyping.current?.(), []);

  const markSend = useCallback((): SharedDraftSendMark => {
    const current = state.current;
    const mark: SharedDraftSendMark = { scope: scopeNow.current };
    marked.current = { mark, op: diffToTextOp(current.text, ''), text: current.text, carried: false };
    return mark;
  }, []);

  const sendClear = useCallback(
    (
      mark: SharedDraftSendMark,
      waitMs: number = SHARED_DRAFT_SEND_CLEAR_WAIT_MS,
    ): SharedDraftSent | undefined | Promise<SharedDraftSent | undefined> => {
      /** The clear, if it can be named exactly now: same session, mark still followed, nothing unanswered. */
      const exact = (): SharedDraftSent | undefined => {
        const ours = marked.current;
        const current = state.current;
        if (!enabled || ours?.mark !== mark || ours.op === undefined || mark.scope !== scopeNow.current)
          return undefined;
        if (current.position === undefined || current.inflight !== undefined || current.buffer !== undefined)
          return undefined;
        if (current.resyncing) return undefined;
        ours.carried = true;
        return {
          generation: current.position.generation,
          epoch: current.position.epoch,
          base: current.position.rev,
          text: ours.op,
        };
      };
      const now = exact();
      if (now !== undefined || !enabled) return now;
      // Answered at once, not on a later tick, whenever there is nothing to wait for.
      // Worth waiting for only an answer that is on its way: an edit in flight on a live stream. With no
      // stream, or nothing sent, there is nothing to wait for and the send goes now.
      const current = state.current;
      const answering =
        link.current !== null &&
        current.position !== undefined &&
        !current.resyncing &&
        (current.inflight !== undefined || current.buffer !== undefined);
      if (!answering) return undefined;
      return new Promise<SharedDraftSent | undefined>(resolve => {
        let cancel: (() => void) | undefined;
        const done = (value: SharedDraftSent | undefined): void => {
          settled.current.delete(listener);
          cancel?.();
          resolve(value);
        };
        const listener = (): void => {
          // A session switch, or the mark gone, ends the wait at once: it is not this session's to clear.
          if (marked.current?.mark !== mark || mark.scope !== scopeNow.current) done(undefined);
          else {
            const ready = exact();
            if (ready !== undefined) done(ready);
          }
        };
        settled.current.add(listener);
        cancel = timers.after(waitMs, () => done(undefined));
      });
    },
    [enabled, timers],
  );

  const abandonSend = useCallback((mark: SharedDraftSendMark): void => {
    if (marked.current?.mark === mark) marked.current = null;
  }, []);

  const sent = useCallback(
    (mark: SharedDraftSendMark, requestId?: string): string | null => {
      const current = marked.current;
      const ours = current?.mark === mark ? current : undefined;
      if (ours !== undefined) marked.current = null;
      // The composer moved on: this send's session is not the one showing, and neither is its draft.
      if (mark.scope !== scopeNow.current) return null;
      const now = state.current.text;
      // Exactly the sent words, when they are still known. When they are not — the text was replaced
      // wholesale since — nothing is invented: a send that carried its clear has the daemon remove them, and
      // otherwise only a box still holding exactly what was sent is emptied.
      const known = ours?.op !== undefined && textOpBaseLength(ours.op) === now.length ? ours.op : undefined;
      const exactlySent = ours !== undefined && !ours.carried && now === ours.text;
      const left = known !== undefined ? applyTextOp(now, known) : exactlySent ? '' : now;
      if (!enabled || left === now) return left;
      stopTyping.current?.();
      // Under the send's own id when it goes at once, so the daemon takes it for the same edit the send carried.
      run(applyLocalText(state.current, left, requestId === undefined ? ids : () => requestId, true), true);
      link.current?.send({ kind: 'presence', typing: false });
      return left;
    },
    [enabled, ids, run],
  );

  const restoreConflict = useCallback((): void => {
    const words = conflict;
    if (words === null) return;
    clearRestore(restoreNow.current, scopeObjectNow.current);
    setConflict(null);
    const current = textNow.current;
    // Added to what is there, never in place of it: what is there is somebody's too.
    callbacks.current.setText(current.trim() === '' ? words : `${current}\n${words}`);
  }, [conflict]);
  const dismissConflict = useCallback((): void => {
    clearRestore(restoreNow.current, scopeObjectNow.current);
    setConflict(null);
  }, []);

  // Read fresh each render: the tick above re-renders once a report has gone stale.
  const now = timers.now();
  const typing = [...peers.values()].filter(peer => peer.typing && now - peer.seenAt < SHARED_DRAFT_TYPING_SHOWN_MS);

  return { typing, conflict, restoreConflict, dismissConflict, markSend, sendClear, sent, abandonSend, live };
}

/** "also typing on Kirin's iPhone", "… on Kirin's iPhone and Desktop": the hint's words, or nothing. */
export const sharedDraftTypingHint = (typing: readonly SharedDraftPeer[]): string | null => {
  const devices = [...new Set(typing.map(peer => peer.device))];
  if (devices.length === 0) return null;
  if (devices.length === 1) return `also typing on ${devices[0]}`;
  return `also typing on ${devices.slice(0, -1).join(', ')} and ${devices.at(-1)}`;
};
