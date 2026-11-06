/**
 * INPUT STUCK: a ferret idle at its prompt with a message of Ferretry's own typed in its box and never
 * submitted.
 *
 * ═══ WHY ═══
 *
 * On 2026-11-02 two ferrets sat for hours with a message typed in their input box and not sent. One was a
 * turn pointer the delivery could not see land on a stalled pane (`landing_unconfirmed`); the other a lead's
 * message whose Enter was swallowed mid-turn, left as `[Pasted text #40 +3 lines]` when the turn ended.
 * Both were `running` at `your-turn` — which every other check reads as a finished ferret waiting on its
 * owner — the Warden called both `healthy`, and every later message to them waited behind the stuck one.
 * The send path now presses Enter on such text itself (bounded); this is the backstop for when that did
 * not happen or did not take.
 *
 * ═══ WHAT IT IS ═══
 *
 * Facts only, from the session's state and its own send ledger. A send is STUCK when it was typed by the
 * daemon (not held for a revive, not still untyped), is not settled for good, and the send tracker says its
 * text is sitting in the composer now (`typedNotSent`). The tracker keeps that flag true to the screen —
 * set when it sees the text, dropped when it does not — for an open send on every look, and for an
 * unconfirmed one for as long as a repair is watched; so the flag, not the turn clock, decides. (A turn
 * clock cannot: a message typed into a three-hour turn whose Enter was swallowed is still there when that
 * same turn ends.) Then, once the ferret has sat at its prompt and the send has been typed for at least
 * {@link STUCK_INPUT_MS}, it is flagged.
 *
 * &B153: ALSO A SEND THE HARNESS TOOK BACK. A delivered turn pointer can reappear in the box after its user
 * record was written (Claude rewinds a prompt cancelled before its first answer into the composer), and the
 * tracker no longer watches a delivered send. So for a ferret idle that long whose newest send is a delivered
 * pointer, the send path reads the box once per sweep; exactly that pointer there is flagged and handled the
 * same way — one verified Enter, then the notice.
 *
 * ═══ WHAT IS DONE ═══
 *
 * Once per EPISODE (one stuck send): the Warden presses Enter on it, through the send path's verified
 * re-submit, which presses only when the box holds exactly that send's text at an idle, undialogued pane.
 * If the text is there and that did not submit it, the ferret is marked `stalled` — never `healthy` — and
 * named on ONE machine notice listing every ferret in that state, which clears itself when the ferret moves
 * again. An EMPTY box proves only that nothing is held now — the message may well have been read — so it
 * is neither marked nor noticed, and nobody is told to send it again.
 *
 * Pure: the fleet, the ledgers and the memory arrive through the arguments.
 */
import { inWardenLineage, type WardenAnomaly } from './detect.ts';
import { isoFromMs, latestInstantMs } from './time.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

/** How long a ferret must sit at its prompt, with a send of ours typed that long, before it is stuck. */
export const STUCK_INPUT_MS = 3 * 60_000;

/** A send typed longer ago than this is history: it is not reported as stuck however it ended. */
export const STUCK_INPUT_HORIZON_MS = 24 * 60 * 60_000;

/** One send, as far as this module reads it. */
export interface StuckInputSend {
  readonly sendId: string;
  readonly path: string;
  readonly fate: string;
  readonly acceptedAt: string;
  readonly attemptAt?: string | undefined;
  readonly fateAt?: string | undefined;
  readonly deadlineAt?: string | undefined;
  readonly typedNotSent?: boolean | undefined;
  readonly held?: boolean | undefined;
  readonly untyped?: boolean | undefined;
  readonly unaccountedReason?: string | undefined;
  readonly fromName?: string | undefined;
}

/** Fates of a send not yet settled for good: still looked for, or typed and unproven. */
const UNSETTLED = new Set(['accepted', 'queued', 'unaccounted']);
/** The transports that type a pointer at a file rather than the message itself. */
const POINTER_PATHS = new Set(['turn-file', 'native-file']);
/** The transports a revive carries: their text is typed by a relaunch, never left behind by a send. */
const REVIVE_PATHS = new Set(['revive', 'revive-queue']);

/**
 * The ferrets whose ledgers are worth reading this sweep: autonomous, not a warden's, still running, at their
 * prompt for at least `stuckMs`. An interactive session is the owner's own terminal, watched by its owner.
 */
export function stuckInputCandidates(
  fleet: readonly WardenSessionView[],
  nowMs: number,
  stuckMs: number = STUCK_INPUT_MS,
): readonly WardenSessionView[] {
  const byId = new Map(fleet.map(view => [view.config.id, view]));
  return fleet.filter(view => {
    const { config, state } = view;
    if (config.mode !== 'auto' || isTerminalStatus(state.status) || state.turnState !== 'your-turn') return false;
    const ended = latestInstantMs(state.turnStateAt);
    if (ended === undefined || nowMs - ended < stuckMs) return false;
    return !inWardenLineage(view, byId);
  });
}

/** When a send was typed: its current attempt, else its acceptance. */
const typedAtMs = (send: StuckInputSend): number => Date.parse(send.attemptAt ?? send.acceptedAt);

/** The newest send of this ferret that is stuck in its box, or `undefined`. See the module comment for the rule. */
export function stuckSendOf(
  sends: readonly StuckInputSend[],
  nowMs: number,
  stuckMs: number = STUCK_INPUT_MS,
): StuckInputSend | undefined {
  let newest: StuckInputSend | undefined;
  for (const send of sends) {
    if (send.held === true || send.untyped === true || REVIVE_PATHS.has(send.path) || !UNSETTLED.has(send.fate))
      continue;
    if (send.typedNotSent !== true) continue;
    const typed = typedAtMs(send);
    if (!Number.isFinite(typed) || nowMs - typed < stuckMs || nowMs - typed > STUCK_INPUT_HORIZON_MS) continue;
    if (newest === undefined || typed > typedAtMs(newest)) newest = send;
  }
  return newest;
}

/** The episode a stuck send is: that send, for that ferret. */
export function stuckInputEpisode(sessionId: string, sendId: string): string {
  return `input:${sessionId}:${sendId}`;
}

/**
 * &B153: whether this ledger's NEWEST typed send is a delivered pointer — the only send a harness can have
 * taken back into the box after it was recorded (`retractedPointer` in the send path owns the full rule).
 * Cheap, from the ledger alone, so the pane is read only for a ferret where the answer could be yes.
 */
export function mayHoldRetractedPointer(sends: readonly StuckInputSend[], nowMs: number): boolean {
  let newest: StuckInputSend | undefined;
  for (const send of sends) {
    if (send.held === true || send.untyped === true || send.fate === 'withdrawn') continue;
    if (newest === undefined || Date.parse(send.acceptedAt) >= Date.parse(newest.acceptedAt)) newest = send;
  }
  if (newest === undefined || newest.fate !== 'delivered' || !POINTER_PATHS.has(newest.path)) return false;
  // Past the horizon it is history, like any stuck send: an old ferret's box is not read every sweep for good.
  return nowMs - typedAtMs(newest) <= STUCK_INPUT_HORIZON_MS;
}

/**
 * The flag for each candidate whose ledger shows a stuck send — or, &B153, whose box the send path has just
 * read holding a delivered pointer the harness took back (`retracted`, session id → send id). The candidate
 * has already sat at its prompt for `stuckMs`, which is the wait such a pointer gets: its own typing is long
 * past, and only the idle time says nobody is about to press Enter on it.
 */
export function detectStuckInput(
  candidates: readonly WardenSessionView[],
  ledgers: ReadonlyMap<string, readonly StuckInputSend[]>,
  nowMs: number,
  stuckMs: number = STUCK_INPUT_MS,
  retracted: ReadonlyMap<string, string> = new Map(),
): readonly (WardenAnomaly & { readonly sendId: string })[] {
  const anomalies: (WardenAnomaly & { readonly sendId: string })[] = [];
  for (const view of candidates) {
    const sends = ledgers.get(view.config.id);
    if (sends === undefined) continue;
    const typed = stuckSendOf(sends, nowMs, stuckMs);
    const takenBack = retracted.get(view.config.id);
    const stuck = typed ?? sends.find(send => send.sendId === takenBack);
    if (stuck === undefined) continue;
    const anchor =
      (typed === undefined
        ? latestInstantMs(view.state.turnStateAt)
        : latestInstantMs(view.state.turnStateAt, stuck.attemptAt ?? stuck.acceptedAt)) ?? nowMs;
    const idleMinutes = Math.floor((nowMs - anchor) / 60_000);
    const from = stuck.fromName === undefined ? 'a message' : `a message from ${stuck.fromName}`;
    anomalies.push({
      kind: 'input_stuck',
      sessionId: view.config.id,
      ...(view.config.teammate === undefined ? {} : { teammate: view.config.teammate }),
      ...(view.config.label === undefined ? {} : { label: view.config.label }),
      status: view.state.status,
      detail: `idle at its prompt for ${idleMinutes}m while ${from} (send ${stuck.sendId}) sits typed in its input box, not sent — everything sent after it waits behind it`,
      since: isoFromMs(anchor),
      idleMinutes,
      subject: stuckInputEpisode(view.config.id, stuck.sendId),
      sendId: stuck.sendId,
    });
  }
  return anomalies;
}

// ── What the Warden does ───────────────────────────────────────────────────────────────────────────────

/** What one Enter on a stuck send did, as the send path says it. */
export type StuckInputPress = 'submitted' | 'holding' | 'absent' | 'refused';

/** What the Warden did about one ferret's stuck send, this episode. */
export interface StuckInputTold {
  readonly sendId: string;
  readonly pressedAt?: string;
  readonly press?: StuckInputPress;
  /** When the ferret was marked stalled and named on the machine notice. */
  readonly noticedAt?: string;
}

/** Keyed by session id, kept while the ferret is flagged. */
export type StuckInputMemory = Readonly<Record<string, StuckInputTold>>;

/** The next step for one flagged ferret. */
export type StuckInputStep =
  | { readonly kind: 'press'; readonly sessionId: string; readonly sendId: string }
  | {
      readonly kind: 'notice';
      readonly sessionId: string;
      readonly sendId: string;
      readonly press?: Exclude<StuckInputPress, 'absent'>;
    };

/**
 * What to do this sweep: press once for a new episode; name a ferret on the notice once its press did not
 * submit the text (or the flag outlived a press that said it did); and take off the notice every ferret no
 * longer flagged. Nothing is pressed or noticed while the Warden is off; recoveries are cleared either way.
 */
export function planStuckInput(input: {
  readonly stuck: readonly { readonly sessionId: string; readonly sendId: string }[];
  readonly memory: StuckInputMemory;
  readonly enabled: boolean;
}): { readonly steps: readonly StuckInputStep[]; readonly recovered: readonly string[] } {
  const flagged = new Set(input.stuck.map(each => each.sessionId));
  const recovered = Object.keys(input.memory).filter(sessionId => !flagged.has(sessionId));
  if (!input.enabled) return { steps: [], recovered };
  const steps: StuckInputStep[] = [];
  for (const { sessionId, sendId } of input.stuck) {
    const told = input.memory[sessionId];
    if (told === undefined || told.sendId !== sendId) {
      steps.push({ kind: 'press', sessionId, sendId });
      continue;
    }
    // An empty box at the press proved nothing is held now: never noticed on that.
    if (told.noticedAt === undefined && told.press !== 'absent')
      steps.push({ kind: 'notice', sessionId, sendId, ...(told.press === undefined ? {} : { press: told.press }) });
  }
  return { steps, recovered };
}

/** The line a ferret gets on the machine notice: who it is, what is stuck, and what the Enter did. */
export function stuckInputNoticeLine(
  anomaly: Pick<WardenAnomaly, 'sessionId' | 'teammate' | 'since'>,
  sendId: string,
  press: Exclude<StuckInputPress, 'absent'> | undefined,
): string {
  const who = anomaly.teammate === undefined ? anomaly.sessionId : `${anomaly.teammate} (${anomaly.sessionId})`;
  const outcome =
    press === 'holding'
      ? 'Enter was pressed and did not take'
      : press === 'refused'
        ? 'Enter could not be pressed (busy, a dialog, other text beside it, or no presses left)'
        : 'Enter was pressed and it is still idle';
  return `${who}: send ${sendId} stuck since ${anomaly.since ?? 'unknown'} — ${outcome}`;
}
