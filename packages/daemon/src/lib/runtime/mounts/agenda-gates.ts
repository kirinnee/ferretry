/**
 * The agenda's half of a card's gate (docs/board.md § Gates ask the owner): the owner's answer to a gate item moves
 * the card FIRST, through the board as the owner, and only a move that went through closes the item.
 *
 * Who may answer: the owner — at the machine (the admin token, recorded `admin-token` on the card), or a paired
 * device the `fleet` grant lets use the board, exactly the caller who could have moved the card on the Board. A
 * ferret, a lead over its sub-ferret and the daemon are refused, here and again in the state machine.
 */
import type { AgendaId, AgendaResponse } from '@ferretry/protocol';
import { grantRefusalCode } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiActor } from '../../api/actor.ts';
import type { RouteContext } from '../../api/route.ts';
import type { AgendaActor, AgendaMutation } from '../../agenda/index.ts';
import type { BoardCaller, GateAnswer, GateAnswerOutcome, GateRefusal } from '../../board/index.ts';
import { boardCaller } from './board.ts';

/** The gate items, as the agenda route needs them. */
export interface AgendaGatePort {
  answer(answer: GateAnswer): Promise<GateAnswerOutcome>;
  isGate(sessionId: string, id: AgendaId): Promise<boolean>;
}

const FLEET_USE = { capability: 'fleet', axis: 'use' } as const;

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
  },
): Promise<AgendaMutation | undefined> {
  const outcome = await gates.answer({
    ...answer,
    caller: callerOf(answer.actor, context.actor),
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
