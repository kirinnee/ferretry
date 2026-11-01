/**
 * ONE OPEN COMPOSER'S LIVE LINE TO THE SHARED DRAFT.
 *
 * Every composer the owner has open on a session holds one of these streams. Down it go the draft (as a
 * snapshot, or edit by edit when the composer is catching up after a reconnect), every edit another
 * composer makes, the answer to each of this composer's own edits, and where the owner's other devices
 * are typing. Up it come this composer's edits and its own caret.
 *
 * ANSWERS ARRIVE IN SEQUENCE ORDER. An edit's `ack` is sent from inside the same notification every other
 * composer hears it by, not after its promise settles — otherwise a composer could hear somebody else's
 * revision 6 before its own revision 5, and a client that counts revisions would be lost.
 *
 * PRESENCE IS NEVER STORED. It lives in {@link SharedDraftPresence} for as long as the stream is open and
 * is gone when it closes; nothing about who typed where reaches the disk or the journal.
 */
import {
  SHARED_DRAFT_ERROR_CODES,
  SHARED_DRAFT_STREAM_FRAME_BUDGET,
  SHARED_DRAFT_STREAM_RESYNC_CLOSE,
  type SharedDraftSnapshot,
  sharedDraftFrameBytes,
  type SharedDraftClientFrame,
  SharedDraftClientFrameSchema,
  type SharedDraftServerFrame,
} from '@ferretry/protocol';
import type { SocketDownstream, SocketFrame, SocketHandler } from '../api/socket.ts';
import {
  type SharedDraftChange,
  type SharedDraftService,
  sharedDraftOrigin,
  splitSharedDraftOrigin,
} from './service.ts';
import { SharedDraftError, type SharedDraftErrorCode } from './types.ts';

/** A slow reader may hold at most this much in the host socket before its stream is closed. */
export const SHARED_DRAFT_STREAM_MAX_BUFFER_BYTES = 1_024 * 1_024;
/** Caret and typing reports one composer may make per second; the rest are dropped, not queued. */
export const SHARED_DRAFT_PRESENCE_PER_SECOND = 4;

export const SHARED_DRAFT_STREAM_CLOSES = {
  malformed: { code: 1008, reason: 'shared draft stream frame not understood' },
  slowReader: { code: 1013, reason: 'shared draft stream reader fell behind' },
  unavailable: { code: 1011, reason: 'shared draft unavailable' },
  /** A frame no record could carry: the composer reads the whole draft again, which comes in parts. */
  oversized: { code: SHARED_DRAFT_STREAM_RESYNC_CLOSE, reason: 'shared draft frame too large; read the draft again' },
} as const;

/** The longest piece of `text` from `start` that keeps `frame(piece)` within the budget, never splitting a surrogate pair. */
const fittingEnd = (text: string, start: number, frame: (piece: string) => unknown): number => {
  let low = start + 1;
  let high = text.length;
  let best = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sharedDraftFrameBytes(frame(text.slice(start, middle))) <= SHARED_DRAFT_STREAM_FRAME_BUDGET) {
      best = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  // Ending on a high surrogate would split one character across two frames.
  if (best > start + 1 && best < text.length) {
    const unit = text.charCodeAt(best - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) best -= 1;
  }
  return Math.max(best, start + 1);
};

/** A draft too big for one frame, as a `snapshot` with the first part of its text and the rest in order. */
export const snapshotFrames = (snapshot: SharedDraftSnapshot): readonly SharedDraftServerFrame[] => {
  const whole: SharedDraftServerFrame = { kind: 'snapshot', snapshot };
  if (sharedDraftFrameBytes(whole) <= SHARED_DRAFT_STREAM_FRAME_BUDGET) return [whole];
  const text = snapshot.text;
  // `more` is measured at its largest, so the count written later never makes the first frame grow.
  const firstEnd = fittingEnd(text, 0, piece => ({
    kind: 'snapshot',
    snapshot: { ...snapshot, text: piece },
    more: 1_000,
  }));
  const parts: string[] = [];
  for (let start = firstEnd; start < text.length; ) {
    const end = fittingEnd(text, start, piece => ({ kind: 'snapshot-text', text: piece }));
    parts.push(text.slice(start, end));
    start = end;
  }
  return [
    { kind: 'snapshot', snapshot: { ...snapshot, text: text.slice(0, firstEnd) }, more: parts.length },
    ...parts.map((part): SharedDraftServerFrame => ({ kind: 'snapshot-text', text: part })),
  ];
};

const ERROR_CODES: Readonly<Record<SharedDraftErrorCode, string>> = {
  'not-found': 'not-found',
  stale: SHARED_DRAFT_ERROR_CODES.stale,
  'too-long': SHARED_DRAFT_ERROR_CODES.tooLong,
  'too-many-items': SHARED_DRAFT_ERROR_CODES.tooManyItems,
  invalid: SHARED_DRAFT_ERROR_CODES.invalid,
};

/** What one composer last said about its caret, kept so a composer that opens later sees it at once. */
interface PresenceState {
  readonly typing: boolean;
  readonly selection?: readonly [number, number];
}

type PresenceFrame = Extract<SharedDraftServerFrame, { kind: 'presence' | 'left' }>;

interface PresenceMember {
  readonly device: string;
  readonly deliver: (frame: PresenceFrame) => void;
  state?: PresenceState;
}

/** Who has which session's composer open, and where their caret is. Memory only. */
export class SharedDraftPresence {
  readonly #sessions = new Map<string, Map<string, PresenceMember>>();

  /** Joins, and hears at once from every composer already open. Answers the way to leave. */
  join(sessionId: string, peer: string, device: string, deliver: (frame: PresenceFrame) => void): () => void {
    const members = this.#sessions.get(sessionId) ?? new Map<string, PresenceMember>();
    this.#sessions.set(sessionId, members);
    for (const [other, member] of members)
      if (member.state !== undefined) deliver(this.#frame(other, member.device, member.state));
    members.set(peer, { device, deliver });
    return () => {
      if (!members.delete(peer)) return;
      if (members.size === 0) this.#sessions.delete(sessionId);
      for (const member of members.values()) member.deliver({ kind: 'left', peer });
    };
  }

  /** How many composers are open on a session: memory that must come back when they close. */
  members(sessionId: string): number {
    return this.#sessions.get(sessionId)?.size ?? 0;
  }

  publish(sessionId: string, peer: string, state: PresenceState): void {
    const members = this.#sessions.get(sessionId);
    const self = members?.get(peer);
    if (members === undefined || self === undefined) return;
    self.state = state;
    for (const [other, member] of members) if (other !== peer) member.deliver(this.#frame(peer, self.device, state));
  }

  #frame(peer: string, device: string, state: PresenceState): PresenceFrame {
    return {
      kind: 'presence',
      peer,
      device,
      typing: state.typing,
      ...(state.selection === undefined ? {} : { selection: state.selection }),
    };
  }
}

export interface SharedDraftStreamTarget {
  readonly sessionId: string;
  /** This stream's own id among the session's open composers. */
  readonly peer: string;
  /** The device this composer runs on, as the owner named it when pairing. */
  readonly device: string;
  /** Where the composer's copy stood when it last had a stream, so only what it missed is sent. */
  readonly position?: { readonly generation: string; readonly epoch: number; readonly rev: number };
}

/** The clock presence rate limiting reads; injected so a test drives it. */
export interface SharedDraftStreamClock {
  nowMs(): number;
}

interface Position {
  readonly epoch: number;
  readonly rev: number;
}

/** Whether a change leaves the draft past `position`: a later epoch, or a later revision in the same one. */
const later = (change: Position, position: Position): boolean =>
  change.epoch > position.epoch || (change.epoch === position.epoch && change.rev > position.rev);

export class SharedDraftStreamHandler implements SocketHandler {
  #closed = false;
  #unsubscribe: (() => void) | undefined;
  #leave: (() => void) | undefined;
  /** Presence reports in the current one-second window. */
  #presenceWindow = { startedAt: 0, count: 0 };

  constructor(
    private readonly drafts: SharedDraftService,
    private readonly presence: SharedDraftPresence,
    private readonly target: SharedDraftStreamTarget,
    private readonly downstream: SocketDownstream,
    private readonly clock: SharedDraftStreamClock,
  ) {}

  async open(): Promise<void> {
    const { sessionId, peer } = this.target;
    // Listening starts BEFORE the catch-up is read, and everything heard meanwhile waits behind it, so no
    // edit falls between the two and none arrives out of order.
    const early: SharedDraftChange[] = [];
    let caughtUp = false;
    this.#unsubscribe = this.drafts.subscribe(sessionId, change => {
      if (!caughtUp) early.push(change);
      else this.#deliver(change);
    });
    try {
      const missed =
        this.target.position === undefined ? undefined : await this.drafts.since(sessionId, this.target.position);
      let reached: Position;
      if (missed === undefined) {
        const snapshot = await this.drafts.read(sessionId);
        for (const frame of snapshotFrames(snapshot)) this.#send(frame);
        reached = snapshot;
      } else {
        for (const change of missed) this.#deliver(change);
        reached = missed.at(-1) ?? (this.target.position as Position);
      }
      // What was heard while catching up and is not already covered by it.
      for (const change of early.splice(0)) if (later(change, reached)) this.#deliver(change);
      caughtUp = true;
      // Closed while catching up: joining now would leave a member nobody ever removes.
      if (this.#closed) return;
      this.#send({ kind: 'ready' });
    } catch {
      this.#fail(SHARED_DRAFT_STREAM_CLOSES.unavailable);
      return;
    }
    if (this.#closed) return;
    this.#leave = this.presence.join(sessionId, peer, this.target.device, frame => this.#send(frame));
  }

  fromClient(frame: SocketFrame): void {
    if (this.#closed) return;
    const parsed = this.#parse(frame);
    if (parsed === undefined) {
      this.#fail(SHARED_DRAFT_STREAM_CLOSES.malformed);
      return;
    }
    if (parsed.kind === 'presence') {
      this.#presence(parsed);
      return;
    }
    const origin = sharedDraftOrigin(this.target.peer, parsed.id);
    this.drafts.edit(this.target.sessionId, parsed.edit, origin).catch((error: unknown) => {
      if (error instanceof SharedDraftError)
        this.#send({ kind: 'error', id: parsed.id, code: ERROR_CODES[error.code], message: error.message });
      else this.#fail(SHARED_DRAFT_STREAM_CLOSES.unavailable);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#leave?.();
  }

  #presence(frame: Extract<SharedDraftClientFrame, { kind: 'presence' }>): void {
    const now = this.clock.nowMs();
    if (now - this.#presenceWindow.startedAt >= 1_000) this.#presenceWindow = { startedAt: now, count: 0 };
    this.#presenceWindow.count += 1;
    if (this.#presenceWindow.count > SHARED_DRAFT_PRESENCE_PER_SECOND) return;
    this.presence.publish(this.target.sessionId, this.target.peer, {
      typing: frame.typing,
      ...(frame.selection === undefined ? {} : { selection: frame.selection }),
    });
  }

  /** Another composer's edit, or — tagged with this stream's own id — the answer to one of ours. */
  #deliver(change: SharedDraftChange): void {
    const origin = splitSharedDraftOrigin(change.origin);
    if (origin?.stream === this.target.peer)
      this.#send({
        kind: 'ack',
        id: origin.editId,
        applied: change.applied,
        epoch: change.epoch,
        rev: change.rev,
      });
    else
      this.#send({
        kind: 'edit',
        ...(origin === undefined ? {} : { id: origin.editId }),
        applied: change.applied,
        epoch: change.epoch,
        rev: change.rev,
      });
  }

  #parse(frame: SocketFrame): SharedDraftClientFrame | undefined {
    if (typeof frame !== 'string') return undefined;
    try {
      const result = SharedDraftClientFrameSchema.safeParse(JSON.parse(frame));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  #send(frame: SharedDraftServerFrame): void {
    if (this.#closed) return;
    if (this.downstream.bufferedBytes() > SHARED_DRAFT_STREAM_MAX_BUFFER_BYTES) {
      this.#fail(SHARED_DRAFT_STREAM_CLOSES.slowReader);
      return;
    }
    // Every frame this stream makes fits but an edit sent through the plain route, which may be bigger
    // than a record holds: rather than a link that fails on it forever, the composer starts afresh.
    if (sharedDraftFrameBytes(frame) > SHARED_DRAFT_STREAM_FRAME_BUDGET) {
      this.#fail(SHARED_DRAFT_STREAM_CLOSES.oversized);
      return;
    }
    let sent: number | undefined;
    try {
      sent = this.downstream.send(JSON.stringify(frame));
    } catch {
      sent = undefined;
    }
    // Refused: on a relay the link is already gone; on a plain socket it is backpressure. Either way the
    // reader is not keeping up, and a socket with a dead handler behind it must not stay open.
    if (sent === undefined || sent < 0) this.#fail(SHARED_DRAFT_STREAM_CLOSES.slowReader);
  }

  #fail(close: { readonly code: number; readonly reason: string }): void {
    if (this.#closed) return;
    this.close();
    this.downstream.close(close.code, close.reason);
  }
}
