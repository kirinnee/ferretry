/**
 * The agenda's half of a card ask (docs/agenda.md § Card asks): the owner's answer to a card ask moves the card
 * FIRST, through the board as the owner, and only a move that went through records the answer; the agenda then rests.
 *
 * Who may answer: the owner — at the machine (the admin token, recorded `admin-token` on the card), or a paired
 * device the `fleet` grant lets use the board, exactly the caller who could have moved the card on the Board. A
 * ferret, a lead over its sub-ferret and the daemon are refused here; the state machine records a card ask's answer
 * only from the daemon itself, once this check passed and the card moved.
 */
import { type ApiActor, cap, grantRefusalCode, parseActor } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext } from '@ferretry/kernel/contract';
import type { AgendaActor, AgendaMutation } from '../agenda/index.ts';
import type { AgendaId, AgendaResponse } from '../protocol/agenda.ts';
import type { BoardReopenAttachments } from '../protocol/board-refs.ts';

type RouteContext = CallContext;

/**
 * Who the board records a card move as (today's `BoardCaller`). This is Asks' side of the card-ask seam: the Board
 * plugin's `card` source answers through it once the card-ask flow is settled (an `apply(answer)` before an ask is
 * answered is still a lead decision), and until then no build wires it, so a card ask is answered like any choice.
 */
export type BoardCaller =
  | { readonly kind: 'owner'; readonly via?: 'admin-token' }
  | { readonly kind: 'ferret'; readonly sessionId: string }
  | { readonly kind: 'daemon'; readonly sessionId?: string };

/** Why the board refused to move the card (today's `GateRefusal`). */
export interface GateRefusal {
  readonly code: 'forbidden' | 'invalid' | 'moved-on' | 'not-moved';
  readonly message: string;
}

/** What answering a card ask came to (today's `GateAnswerOutcome`). */
export type GateAnswerOutcome =
  | { readonly handled: false }
  | { readonly handled: true; readonly mutation: AgendaMutation }
  | { readonly handled: true; readonly refused: GateRefusal };

/** One answer to a card ask, as the agenda route received it (today's `GateAnswer`). */
export interface GateAnswer {
  readonly sessionId: string;
  readonly id: AgendaId;
  readonly response: AgendaResponse;
  readonly note?: string | null | undefined;
  /** Files the owner brings with a Not good, uploaded to THIS agenda's ferret. */
  readonly attachments?: BoardReopenAttachments | undefined;
  readonly actor: AgendaActor;
  readonly caller: BoardCaller;
  /** The paired device that answered, by its holder id; absent for the owner at the machine. */
  readonly holder?: string | undefined;
  readonly cardAsk?: string | undefined;
  readonly askVersion?: number | undefined;
  /** Whether this human may move the card at all, asked only once the answer is known to be to a card ask. */
  readonly permitted?: () => string | undefined;
}

/** Today's `boardCaller`: a ferret by its own actor, the admin token as itself, a paired device as the owner. */
const boardCaller = (actor: ApiActor | undefined): BoardCaller => {
  const parsed = parseActor(actor ?? '');
  if (parsed.kind === 'ferret' && parsed.id !== undefined && parsed.id !== '')
    return { kind: 'ferret', sessionId: parsed.id };
  // The host's admin token with no ferret's credential: the owner at the machine OR a ferret that left its
  // session out, and the daemon cannot tell which. It keeps the owner's authority and is RECORDED as the token.
  if (parsed.kind === 'admin-cli' || parsed.kind === 'admin-ui') return { kind: 'owner', via: 'admin-token' };
  if (parsed.kind === 'device' && parsed.id !== undefined && parsed.id !== '') return { kind: 'owner' };
  throw new ApiError(403, 'only a ferret in its own pane or the owner may write to the board', 'forbidden');
};

/** The gate items, as the agenda route needs them. */
export interface AgendaGatePort {
  answer(answer: GateAnswer): Promise<GateAnswerOutcome>;
  isGate(sessionId: string, id: AgendaId): Promise<boolean>;
}

const FLEET_USE = cap('fleet', 'use');

const STATUS: Readonly<Record<GateRefusal['code'], readonly [number, string]>> = {
  forbidden: [403, 'forbidden'],
  invalid: [400, 'invalid'],
  'moved-on': [409, 'gate_moved_on'],
  'not-moved': [409, 'gate_not_moved'],
};

/**
 * Who the board records the owner's move as. Anyone else is refused before the board is touched, so they are named
 * as nobody the board would let through a gate.
 */
const callerOf = (actor: AgendaActor, apiActor: ApiActor | undefined): BoardCaller =>
  actor.kind === 'human' ? boardCaller(apiActor) : { kind: 'daemon' };

/**
 * A device may answer a gate only where it may use the board: the `fleet` grant on `use`, as the board's own routes
 * ask. Fails closed when the boundary handed this route no standing to read.
 */
const refusedDevice = (context: RouteContext): ApiError | undefined => {
  const decision = context.governance?.decide(FLEET_USE);
  if (decision === undefined) {
    return new ApiError(
      403,
      'this daemon could not check whether this caller may move cards, so nothing was moved (update it: fy daemon update)',
      'forbidden',
    );
  }
  if (decision.allowed) return undefined;
  return new ApiError(
    403,
    'this device may not use the agent fleet, so it may not move a card',
    grantRefusalCode(decision.refusal),
  );
};

/**
 * The owner's Not needed on a gate item leaves the card where it is, quietly — so only a caller who could answer the
 * item may say it: a device needs the board's `fleet` grant, as an answer does. Throws the refusal.
 */
export async function refuseGateDismissal(
  gates: AgendaGatePort,
  context: RouteContext,
  dismissal: { readonly sessionId: string; readonly id: AgendaId; readonly actor: AgendaActor },
): Promise<void> {
  if (dismissal.actor.kind !== 'human' || !(await gates.isGate(dismissal.sessionId, dismissal.id))) return;
  const refused = refusedDevice(context);
  if (refused !== undefined) throw refused;
}

/**
 * Answers a gate item, or `undefined` when the item is not one (the answer is then recorded as any other). Throws
 * the refusals; a refusal leaves the item open.
 */
export async function answerGate(
  gates: AgendaGatePort,
  context: RouteContext,
  answer: {
    readonly sessionId: string;
    readonly id: AgendaId;
    readonly response: AgendaResponse;
    readonly note?: string | undefined;
    readonly actor: AgendaActor;
    readonly cardAsk?: string | undefined;
    readonly askVersion?: number | undefined;
    readonly attachments?: BoardReopenAttachments | undefined;
  },
): Promise<AgendaMutation | undefined> {
  const outcome = await gates.answer({
    ...answer,
    caller: callerOf(answer.actor, context.actor),
    ...(context.credential?.tokenClass === 'device' ? { holder: String(context.credential.principal.holder) } : {}),
    // Asked only of a gate item, and only before the board is touched.
    permitted: () => (answer.actor.kind === 'human' ? refusedDevice(context)?.message : undefined),
  });
  if (!outcome.handled) return undefined;
  if ('refused' in outcome) {
    const [status, code] = STATUS[outcome.refused.code];
    throw new ApiError(status, outcome.refused.message, code);
  }
  return outcome.mutation;
}
