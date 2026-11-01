/**
 * ONE COMPOSER'S COPY OF THE SHARED DRAFT, KEPT IN STEP WITH THE DAEMON.
 *
 * The daemon is the one sequencer (`@ferretry/protocol` `shared-draft.ts`). This is the other half of
 * that bargain, the textbook central-server OT client: at most ONE edit is in flight, everything done
 * meanwhile is folded into one buffered edit behind it, and every edit the daemon hands down from
 * another device is transformed past both before it touches what is on screen. The daemon's edit is
 * always passed FIRST to `transformTextOps`, exactly as the daemon does, so a tie breaks the same way on
 * every device.
 *
 * AN EDIT IS TEXT AND ITEMS TOGETHER. The files and places riding with the draft travel in the same
 * edits as the words, so they share its revisions. Items need no transform: they are a set by id, and
 * every device applies `remove` before `add`, as the daemon does.
 *
 * Pure: it takes frames and the person's changes, and answers with what to show, the text edit that
 * produced it (so a caret can be moved), and the frames to send. The stream, the timers and React live
 * elsewhere (`shared-draft-stream.ts`, `hooks/use-shared-draft.ts`).
 *
 * WHAT IS NEVER MERGED BLINDLY. When this copy cannot be brought into step edit by edit — a refused
 * edit, a daemon that restarted, a first connection that finds different words already there — the
 * daemon's draft wins on screen, and the words this device had are handed back as `conflict`, for the
 * person to restore with one tap. Files this device had added are added again: adding a file the
 * person attached can never cost anybody their words.
 */
import {
  applyTextOp,
  composeTextOps,
  diffToTextOp,
  isNoopTextOp,
  normalizeTextOp,
  SHARED_DRAFT_EDIT_BUDGET,
  type SharedDraftClientFrame,
  type SharedDraftItem,
  type SharedDraftServerFrame,
  sharedDraftFrameBytes,
  type TextOp,
  textOpBaseLength,
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
  readonly add: readonly SharedDraftItem[];
  readonly remove: readonly string[];
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
  /** What the person sees: the daemon's words with this device's unanswered edits on top. */
  readonly text: string;
  /** The files and places the person sees, the same way. */
  readonly items: readonly SharedDraftItem[];
  /** The items as the daemon last confirmed them. */
  readonly serverItems: readonly SharedDraftItem[];
  /** Unset until the first snapshot: nothing is sent before this copy knows what it is editing. */
  readonly position?: SharedDraftPosition;
  readonly inflight?: InflightEdit;
  readonly buffer?: PendingEdit;
  /** Set after a refusal: everything is held until a fresh snapshot arrives. */
  readonly resyncing: boolean;
  /** Items a refused edit was adding, to be added again once the snapshot arrives. */
  readonly lost?: readonly SharedDraftItem[];
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

export const initialSharedDraftState = (
  text: string,
  items: readonly SharedDraftItem[] = [],
): SharedDraftSyncState => ({ text, items, serverItems: [], resyncing: false });

/** Mints the id an edit travels under; injected so a test can predict it. */
export type SharedDraftIdSource = () => string;

/** `remove` first, then `add` — the daemon's order, so every device ends with the same chips. */
export const applyItems = (
  items: readonly SharedDraftItem[],
  add: readonly SharedDraftItem[],
  remove: readonly string[],
): readonly SharedDraftItem[] => {
  const kept = items.filter(item => !remove.includes(item.id));
  const added = add.filter(
    (item, index) =>
      !kept.some(existing => existing.id === item.id) && add.findIndex(other => other.id === item.id) === index,
  );
  return [...kept, ...added];
};

/** `a` then `b` as one edit. */
const composePending = (a: PendingEdit, b: PendingEdit): PendingEdit => ({
  op: composeTextOps(a.op, b.op),
  remove: [...new Set([...a.remove, ...b.remove])],
  add: [...a.add.filter(item => !b.remove.includes(item.id) && !b.add.some(next => next.id === item.id)), ...b.add],
  sent: a.sent || b.sent,
});

const identity = (text: string): TextOp => (text.length === 0 ? [] : [text.length]);

/** What the person sees: the confirmed items with this device's unanswered changes on top. */
const visibleItems = (
  serverItems: readonly SharedDraftItem[],
  inflight: PendingEdit | undefined,
  buffer: PendingEdit | undefined,
): readonly SharedDraftItem[] => {
  let items = serverItems;
  for (const pending of [inflight, buffer])
    if (pending !== undefined) items = applyItems(items, pending.add, pending.remove);
  return items;
};

const editFrame = (position: SharedDraftPosition, inflight: InflightEdit): SharedDraftClientFrame => ({
  kind: 'edit',
  id: inflight.id,
  edit: {
    generation: position.generation,
    epoch: inflight.epoch,
    base: inflight.base,
    text: inflight.op,
    ...(inflight.add.length === 0 ? {} : { add: inflight.add }),
    ...(inflight.remove.length === 0 ? {} : { remove: inflight.remove }),
    ...(inflight.sent ? { sent: true as const } : {}),
  },
});

/** Puts `pending` in flight when nothing is, and answers the frame that carries it. */
/**
 * `op` as two edits run one after the other: the first inserts at most `budget` characters, the second
 * does the rest. Composed, they are exactly `op`; a surrogate pair is never cut.
 */
export const splitTextOp = (op: TextOp, budget: number): readonly [TextOp, TextOp] => {
  const prefix: (number | string)[] = [];
  let left = budget;
  let consumed = 0;
  let produced = 0;
  let index = 0;
  let carried: string | undefined;
  for (; index < op.length; index += 1) {
    const component = op[index] as number | string;
    if (typeof component === 'string') {
      if (component.length <= left) {
        prefix.push(component);
        left -= component.length;
        produced += component.length;
        continue;
      }
      let cut = left;
      const unit = component.charCodeAt(cut - 1);
      if (cut > 0 && unit >= 0xd800 && unit <= 0xdbff) cut -= 1;
      if (cut > 0) {
        prefix.push(component.slice(0, cut));
        produced += cut;
      }
      carried = component.slice(cut);
      index += 1;
      break;
    }
    if (left === 0) break;
    prefix.push(component);
    if (component > 0) {
      consumed += component;
      produced += component;
    } else consumed -= component;
  }
  const base = textOpBaseLength(op);
  const first = normalizeTextOp([...prefix, base - consumed]);
  const second = normalizeTextOp([produced, ...(carried === undefined ? [] : [carried]), ...op.slice(index)]);
  return [first, second];
};

const insertedChars = (op: TextOp): number =>
  op.reduce<number>((total, component) => total + (typeof component === 'string' ? component.length : 0), 0);

/**
 * Puts `pending` in flight when nothing is, and answers the frame that carries it. An edit too big for
 * one frame on the wire (`SHARED_DRAFT_EDIT_BUDGET`) is sent in parts: the first goes now, the rest waits
 * as the buffered edit behind it — a big paste arrives in a few edits instead of wedging the stream.
 */
const launch = (
  state: SharedDraftSyncState,
  pending: PendingEdit,
  ids: SharedDraftIdSource,
): { state: SharedDraftSyncState; send: SharedDraftClientFrame[] } => {
  const position = state.position;
  if (position === undefined || state.resyncing) return { state: { ...state, buffer: pending }, send: [] };
  const { buffer: _buffer, ...rest } = state;
  let first = pending;
  let remainder: PendingEdit | undefined;
  const measure = (candidate: PendingEdit): number =>
    sharedDraftFrameBytes(
      editFrame(position, { ...candidate, id: 'x'.repeat(64), epoch: position.epoch, base: position.rev }),
    );
  while (measure(first) > SHARED_DRAFT_EDIT_BUDGET && insertedChars(first.op) > 1) {
    const [head, tail] = splitTextOp(first.op, Math.floor(insertedChars(first.op) / 2));
    // The files and places go with the first part; a send's mark stays on the last.
    const later: PendingEdit = { op: tail, add: [], remove: [], sent: first.sent };
    remainder = remainder === undefined ? later : composePending(later, remainder);
    first = { ...first, op: head, sent: false };
  }
  const inflight: InflightEdit = { ...first, id: ids(), epoch: position.epoch, base: position.rev };
  return {
    state: { ...rest, inflight, ...(remainder === undefined ? {} : { buffer: remainder }) },
    send: [editFrame(position, inflight)],
  };
};

/**
 * The stream could not carry a frame and was closed for it: start again from the whole draft (which
 * comes in parts), offering back whatever this device had not had answered.
 */
export const applyResync = (state: SharedDraftSyncState): SharedDraftSyncState => {
  const { inflight, buffer, ...rest } = state;
  const lost = [...(inflight?.add ?? []), ...(buffer?.add ?? [])];
  return { ...rest, resyncing: true, ...(lost.length === 0 ? {} : { lost }) };
};

const isEmpty = (pending: PendingEdit): boolean =>
  isNoopTextOp(pending.op) && pending.add.length === 0 && pending.remove.length === 0 && !pending.sent;

/** One local change, folded behind the edit in flight or sent now. */
const local = (
  state: SharedDraftSyncState,
  change: PendingEdit,
  next: Partial<SharedDraftSyncState>,
  ids: SharedDraftIdSource,
): SharedDraftStep => {
  const changed: SharedDraftSyncState = { ...state, ...next };
  if (state.position === undefined) return { state: changed, send: [] };
  if (state.resyncing) {
    // Held until the snapshot; files added meanwhile are added again then, like the refused ones.
    const lost = applyItems(state.lost ?? [], change.add, change.remove);
    return { state: { ...changed, lost }, send: [] };
  }
  if (state.inflight !== undefined) {
    const buffer = state.buffer === undefined ? change : composePending(state.buffer, change);
    return { state: { ...changed, buffer }, send: [] };
  }
  if (isEmpty(change)) return { state: changed, send: [] };
  return launch(changed, change, ids);
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
  const change: PendingEdit = { op: diffToTextOp(state.text, next), add: [], remove: [], sent };
  return local(state, change, { text: next }, ids);
};

/**
 * The person added or removed files and places. `remove` goes first, so an id in both replaces the
 * item (a place renamed, say).
 */
export const applyLocalItems = (
  state: SharedDraftSyncState,
  change: { readonly add?: readonly SharedDraftItem[]; readonly remove?: readonly string[] },
  ids: SharedDraftIdSource,
): SharedDraftStep => {
  const add = change.add ?? [];
  // Removing what is not there is nothing at all, not an edit.
  const remove = (change.remove ?? []).filter(id => state.items.some(item => item.id === id));
  if (add.length === 0 && remove.length === 0) return { state, send: [] };
  const pending: PendingEdit = { op: identity(state.text), add, remove, sent: false };
  return local(state, pending, { items: applyItems(state.items, add, remove) }, ids);
};

/** The whole draft: on first connection, after a refusal, or when a reconnect cannot be caught up. */
const fromSnapshot = (
  state: SharedDraftSyncState,
  frame: Extract<SharedDraftServerFrame, { kind: 'snapshot' }>,
  ids: SharedDraftIdSource,
): SharedDraftStep => {
  const { snapshot } = frame;
  const position: SharedDraftPosition = { generation: snapshot.generation, epoch: snapshot.epoch, rev: snapshot.rev };
  const fresh: SharedDraftSyncState = {
    text: snapshot.text,
    items: snapshot.items,
    serverItems: snapshot.items,
    position,
    resyncing: false,
  };
  // Files this device added that the daemon does not have: on first contact every one it holds, after a
  // refusal the ones the refused edits were adding.
  const mineItems = state.position === undefined && !state.resyncing ? state.items : (state.lost ?? []);
  const readd = mineItems.filter(item => !snapshot.items.some(existing => existing.id === item.id));
  const mine = state.text;
  // First contact with a draft NOBODY HAS EVER TOUCHED (epoch 0, revision 0): what this device was
  // already holding — a draft from before drafts were shared — becomes the draft. An empty draft that has
  // been used is not that: it may be empty because its words were SENT, and this device's cached copy of
  // them must never seed the next message on its own.
  const untouched = snapshot.epoch === 0 && snapshot.rev === 0 && snapshot.text === '';
  const firstPush = state.position === undefined && untouched && !state.resyncing && mine !== '';
  // A copy that was in step and had nothing unanswered simply missed what happened elsewhere — a send
  // from another device, most often: the draft as it now stands is taken, and nothing is offered back.
  const unanswered = state.inflight !== undefined || state.buffer !== undefined || state.resyncing;
  const offered =
    mine !== snapshot.text && !firstPush && mine.trim() !== '' && (state.position === undefined || unanswered);
  const conflict = offered ? mine : undefined;
  const op = firstPush ? diffToTextOp('', mine) : identity(snapshot.text);
  if (!firstPush && readd.length === 0)
    return { state: fresh, send: [], ...(conflict === undefined ? {} : { conflict }) };
  const step = launch(fresh, { op, add: readd, remove: [], sent: false }, ids);
  return {
    state: { ...step.state, text: firstPush ? mine : snapshot.text, items: applyItems(snapshot.items, readd, []) },
    send: step.send,
    ...(conflict === undefined ? {} : { conflict }),
  };
};

/** Somebody else's edit, as sequenced: transformed past what this device has not had answered yet. */
const fromRemote = (
  state: SharedDraftSyncState,
  frame: Extract<SharedDraftServerFrame, { kind: 'edit' }>,
): SharedDraftStep => {
  const position = state.position;
  if (position === undefined) return { state, send: [] };
  let remote = frame.applied.text;
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
  const serverItems = applyItems(state.serverItems, frame.applied.add, frame.applied.remove);
  return {
    state: {
      ...state,
      text: applyTextOp(state.text, remote),
      serverItems,
      items: visibleItems(serverItems, inflight, buffer),
      position: { ...position, epoch: frame.epoch, rev: frame.rev },
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
  frame: Extract<SharedDraftServerFrame, { kind: 'edit' | 'ack' }>,
  ids: SharedDraftIdSource,
): SharedDraftStep => {
  const position = state.position;
  if (position === undefined) return { state, send: [] };
  const { inflight: _inflight, buffer, ...rest } = state;
  const serverItems = applyItems(state.serverItems, frame.applied.add, frame.applied.remove);
  // Never backwards: a repeat is answered where its first copy left the draft, which may be behind
  // what this composer has already heard since.
  const later = frame.epoch > position.epoch || (frame.epoch === position.epoch && frame.rev > position.rev);
  const settled: SharedDraftSyncState = {
    ...rest,
    serverItems,
    items: visibleItems(serverItems, undefined, buffer),
    position: later ? { ...position, epoch: frame.epoch, rev: frame.rev } : position,
  };
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
      return state.inflight?.id === frame.id ? answered(state, frame, ids) : { state, send: [] };
    case 'edit':
      // Our own edit, landed while the stream was down: it is answered, not somebody else's.
      if (frame.id !== undefined && frame.id === state.inflight?.id) return answered(state, frame, ids);
      return fromRemote(state, frame);
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
      // Refused: hold everything, and start again from the daemon's whole draft — remembering the files
      // the refused edits were adding, so they can be added again.
      const { inflight, buffer, ...rest } = state;
      const lost = [...inflight.add, ...(buffer?.add ?? [])];
      return { state: { ...rest, resyncing: true, lost }, send: [], resync: true };
    }
    default:
      return { state, send: [] };
  }
};
