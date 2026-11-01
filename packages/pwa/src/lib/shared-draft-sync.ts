/**
 * ONE COMPOSER'S COPY OF THE SHARED DRAFT, KEPT IN STEP WITH THE DAEMON.
 *
 * The daemon is the one sequencer (`@ferretry/protocol` `shared-draft.ts`). This is the other half of
 * that bargain, the textbook central-server OT client: at most ONE edit is in flight, everything typed
 * meanwhile is folded into one buffered edit behind it, and every edit the daemon hands down from
 * another device is transformed past both before it touches the text on screen. The daemon's edit is
 * always passed FIRST to `transformTextOps`, exactly as the daemon does, so a tie breaks the same way on
 * every device.
 *
 * Pure: it takes frames and the person's typing, and answers with the text to show, the edit that
 * produced it (so a caret can be moved), and the frames to send. The stream, the timers and React live
 * elsewhere (`shared-draft-stream.ts`, `components/use-shared-draft.ts`).
 *
 * WHAT IS NEVER MERGED BLINDLY. When this copy cannot be brought into step edit by edit — a refused
 * edit, a daemon that restarted, a first connection that finds different words already there — the
 * daemon's draft wins on screen, and what this device had is handed back as `conflict`, for the person
 * to restore with one tap. Words are never silently dropped, and never silently spliced into text they
 * were not typed against.
 */
import {
  applyTextOp,
  composeTextOps,
  diffToTextOp,
  isNoopTextOp,
  type SharedDraftClientFrame,
  type SharedDraftServerFrame,
  type TextOp,
  transformTextOps,
} from '@ferretry/protocol';

/** Where this copy last agreed with the daemon. */
export interface SharedDraftPosition {
  readonly generation: string;
  readonly epoch: number;
  readonly rev: number;
}

interface PendingEdit {
  readonly op: TextOp;
  /** Part of a send: the daemon may end the message if nothing is left. */
  readonly sent: boolean;
}

interface InflightEdit extends PendingEdit {
  readonly id: string;
  readonly epoch: number;
  readonly base: number;
  /**
   * Sent on a stream that has since closed without answering. Only such an edit is sent again when the
   * next stream is caught up — one sent on the CURRENT stream is still on its way, and sending it twice
   * would apply it twice.
   */
  readonly orphaned?: true;
}

export interface SharedDraftSyncState {
  /** What the person sees: the daemon's draft with this device's unanswered edits on top. */
  readonly text: string;
  /** Unset until the first snapshot: nothing is sent before this copy knows what it is editing. */
  readonly position?: SharedDraftPosition;
  readonly inflight?: InflightEdit;
  readonly buffer?: PendingEdit;
  /** Set after a refusal: everything is held until a fresh snapshot arrives. */
  readonly resyncing: boolean;
}

/** What one step produced. */
export interface SharedDraftStep {
  readonly state: SharedDraftSyncState;
  /** Frames to send up the stream, in order. */
  readonly send: readonly SharedDraftClientFrame[];
  /** The edit that changed the visible text, when somebody else's edit did — for moving a caret. */
  readonly remote?: TextOp;
  /** Words this device had that could not be merged, offered back to the person. */
  readonly conflict?: string;
  /** The copy needs the whole draft again: reconnect without a position. */
  readonly resync?: true;
}

export const initialSharedDraftState = (text: string): SharedDraftSyncState => ({ text, resyncing: false });

/** Mints the id an edit travels under; injected so a test can predict it. */
export type SharedDraftIdSource = () => string;

const editFrame = (position: SharedDraftPosition, inflight: InflightEdit): SharedDraftClientFrame => ({
  kind: 'edit',
  id: inflight.id,
  edit: {
    generation: position.generation,
    epoch: inflight.epoch,
    base: inflight.base,
    text: inflight.op,
    ...(inflight.sent ? { sent: true as const } : {}),
  },
});

/** Puts `pending` in flight when nothing is, and answers the frame that carries it. */
const launch = (
  state: SharedDraftSyncState,
  pending: PendingEdit,
  ids: SharedDraftIdSource,
): { state: SharedDraftSyncState; send: SharedDraftClientFrame[] } => {
  const position = state.position;
  if (position === undefined || state.resyncing) return { state: { ...state, buffer: pending }, send: [] };
  const inflight: InflightEdit = { ...pending, id: ids(), epoch: position.epoch, base: position.rev };
  const { buffer: _buffer, ...rest } = state;
  return { state: { ...rest, inflight }, send: [editFrame(position, inflight)] };
};

/**
 * The person changed the text (typed, pasted, dictated, or a send emptied it — `sent`). Answers the
 * edit to send now, or folds it into the one waiting behind the edit in flight.
 */
export const applyLocalText = (
  state: SharedDraftSyncState,
  next: string,
  ids: SharedDraftIdSource,
  sent = false,
): SharedDraftStep => {
  if (next === state.text && !sent) return { state, send: [] };
  const op = diffToTextOp(state.text, next);
  const changed = { ...state, text: next };
  if (state.position === undefined || state.resyncing) return { state: changed, send: [] };
  if (state.inflight !== undefined) {
    const buffer: PendingEdit =
      state.buffer === undefined
        ? { op, sent }
        : { op: composeTextOps(state.buffer.op, op), sent: state.buffer.sent || sent };
    return { state: { ...changed, buffer }, send: [] };
  }
  if (isNoopTextOp(op) && !sent) return { state: changed, send: [] };
  return launch(changed, { op, sent }, ids);
};

/** The whole draft: on first connection, after a refusal, or when a reconnect cannot be caught up. */
const fromSnapshot = (
  state: SharedDraftSyncState,
  frame: Extract<SharedDraftServerFrame, { kind: 'snapshot' }>,
  ids: SharedDraftIdSource,
): SharedDraftStep => {
  const { snapshot } = frame;
  const position: SharedDraftPosition = { generation: snapshot.generation, epoch: snapshot.epoch, rev: snapshot.rev };
  const fresh: SharedDraftSyncState = { text: snapshot.text, position, resyncing: false };
  const mine = state.text;
  if (mine === snapshot.text) return { state: fresh, send: [] };
  // First contact, nothing on the daemon yet: what this device was already holding becomes the draft.
  if (state.position === undefined && snapshot.text === '' && !state.resyncing) {
    const step = launch(fresh, { op: diffToTextOp('', mine), sent: false }, ids);
    return { state: { ...step.state, text: mine }, send: step.send };
  }
  if (mine.trim() === '') return { state: fresh, send: [] };
  return { state: fresh, send: [], conflict: mine };
};

/** Somebody else's edit, as sequenced: transformed past what this device has not had answered yet. */
const fromRemote = (state: SharedDraftSyncState, op: TextOp, epoch: number, rev: number): SharedDraftStep => {
  const position = state.position;
  if (position === undefined) return { state, send: [] };
  let remote = op;
  let inflight = state.inflight;
  let buffer = state.buffer;
  if (inflight !== undefined) {
    const [remotePrime, inflightPrime] = transformTextOps(remote, inflight.op);
    remote = remotePrime;
    inflight = { ...inflight, op: inflightPrime };
  }
  if (buffer !== undefined) {
    const [remotePrime, bufferPrime] = transformTextOps(remote, buffer.op);
    remote = remotePrime;
    buffer = { ...buffer, op: bufferPrime };
  }
  return {
    state: {
      ...state,
      text: applyTextOp(state.text, remote),
      position: { ...position, epoch, rev },
      ...(inflight === undefined ? {} : { inflight }),
      ...(buffer === undefined ? {} : { buffer }),
    },
    send: [],
    remote,
  };
};

/** This device's own edit, answered: the next one goes. */
const answered = (
  state: SharedDraftSyncState,
  epoch: number,
  rev: number,
  ids: SharedDraftIdSource,
): SharedDraftStep => {
  const position = state.position;
  if (position === undefined) return { state, send: [] };
  const { inflight: _inflight, buffer, ...rest } = state;
  const settled: SharedDraftSyncState = { ...rest, position: { ...position, epoch, rev } };
  if (buffer === undefined) return { state: settled, send: [] };
  return launch(settled, buffer, ids);
};

/** The stream closed: an edit still unanswered may or may not have landed, and the next stream will say which. */
export const applyDisconnect = (state: SharedDraftSyncState): SharedDraftSyncState =>
  state.inflight === undefined ? state : { ...state, inflight: { ...state.inflight, orphaned: true } };

/** Handles one frame from the daemon. */
export const applyServerFrame = (
  state: SharedDraftSyncState,
  frame: SharedDraftServerFrame,
  ids: SharedDraftIdSource,
): SharedDraftStep => {
  switch (frame.kind) {
    case 'snapshot':
      return fromSnapshot(state, frame, ids);
    case 'ack':
      return state.inflight?.id === frame.id ? answered(state, frame.epoch, frame.rev, ids) : { state, send: [] };
    case 'edit':
      // Our own edit, landed while the stream was down: it is answered, not somebody else's.
      if (frame.id !== undefined && frame.id === state.inflight?.id)
        return answered(state, frame.epoch, frame.rev, ids);
      return fromRemote(state, frame.applied.text, frame.epoch, frame.rev);
    case 'ready': {
      // Caught up, and an edit from the last stream never landed (its own id was not in the replay): send
      // it again. Every edit replayed meanwhile has already been transformed into it, so it now belongs at
      // the revision the copy stands at.
      const position = state.position;
      if (state.inflight?.orphaned !== true || position === undefined) return { state, send: [] };
      const { orphaned: _orphaned, ...pending } = state.inflight;
      const inflight: InflightEdit = { ...pending, epoch: position.epoch, base: position.rev };
      return { state: { ...state, inflight }, send: [editFrame(position, inflight)] };
    }
    case 'error': {
      if (state.inflight?.id !== frame.id) return { state, send: [] };
      // Refused: hold everything, and start again from the daemon's whole draft.
      const { inflight: _inflight, buffer: _buffer, ...rest } = state;
      return { state: { ...rest, resyncing: true }, send: [], resync: true };
    }
    default:
      return { state, send: [] };
  }
};
