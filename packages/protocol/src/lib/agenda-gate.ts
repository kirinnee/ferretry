/**
 * GATE ITEMS: the agenda item the daemon raises when an owner-asked card enters a lane whose stage is a gate
 * (docs/board.md § Gates ask the owner). The wire field is `AgendaItem.gate` (`agenda.ts`); this file owns the
 * pure facts both ends read off it — the item's stable reference, the ask it presents, which swipe gives which
 * option, and what a chosen label means.
 */
import type { AgendaAskOption, AgendaCardAnswer, AgendaDirection, AgendaGate, AgendaGateOption } from './agenda.ts';

const GATE_REFERENCE_PREFIX = 'gate:';
const GATE_FOLLOWUP_REFERENCE_PREFIX = 'gate-followup:';

/** A card id, a lane id and an entry as a reference spells them: no separator inside any of them. */
const CARD_ID = /^[BFIC][1-9][0-9]{0,8}$/u;
const LANE_ID = /^[^\s:]{1,64}$/u;
const ENTRY = /^[1-9][0-9]{0,8}$/u;

/** What a gate item's `sourceRef` names: the card, the gate lane, and the history entry that put it there. */
export interface GateReference {
  readonly cardId: string;
  readonly laneId: string;
  readonly entry: number;
}

/**
 * The `sourceRef` of a gate item: `gate:<card>:<lane>:<entry>`. One per entry into the gate, so raising it again
 * (a restart, a second write that finds the card still there) is the same item.
 */
export const gateReference = (gate: GateReference): string =>
  `${GATE_REFERENCE_PREFIX}${gate.cardId}:${gate.laneId}:${String(gate.entry)}`;

/** The card, lane and entry a `sourceRef` names, or `undefined` for any other reference. Total. */
export const parseGateReference = (sourceRef: string | null | undefined): GateReference | undefined => {
  if (typeof sourceRef !== 'string' || !sourceRef.startsWith(GATE_REFERENCE_PREFIX)) return undefined;
  const parts = sourceRef.slice(GATE_REFERENCE_PREFIX.length).split(':');
  if (parts.length !== 3) return undefined;
  const [cardId = '', laneId = '', entry = ''] = parts;
  if (!CARD_ID.test(cardId) || !LANE_ID.test(laneId) || !ENTRY.test(entry)) return undefined;
  return { cardId, laneId, entry: Number(entry) };
};

/** What a follow-up conversation's `sourceRef` names: the card, and the gate entry the owner said Not good to. */
export interface GateFollowupReference {
  readonly cardId: string;
  readonly entry: number;
}

/** The `sourceRef` of the conversation a reopen-with-agenda answer opens: `gate-followup:<card>:<entry>`. */
export const gateFollowupReference = (followup: GateFollowupReference): string =>
  `${GATE_FOLLOWUP_REFERENCE_PREFIX}${followup.cardId}:${String(followup.entry)}`;

/** The card and entry a follow-up's `sourceRef` names, or `undefined` for any other reference. Total. */
export const parseGateFollowupReference = (sourceRef: string | null | undefined): GateFollowupReference | undefined => {
  if (typeof sourceRef !== 'string' || !sourceRef.startsWith(GATE_FOLLOWUP_REFERENCE_PREFIX)) return undefined;
  const parts = sourceRef.slice(GATE_FOLLOWUP_REFERENCE_PREFIX.length).split(':');
  if (parts.length !== 2) return undefined;
  const [cardId = '', entry = ''] = parts;
  if (!CARD_ID.test(cardId) || !ENTRY.test(entry)) return undefined;
  return { cardId, entry: Number(entry) };
};

/**
 * The extra answer a gate with ONE option offers, because a choice needs two: the card stays where it is and the
 * item closes; any words the owner gave reach the card's ferret. It is never one of `gate.options`, which is how a
 * client tells it apart.
 */
export const GATE_NOT_YET_LABEL = 'Not yet';
const GATE_NOT_YET_FALLBACK = 'Not now';

/** The "not yet" label of a gate with one option, or `undefined` when its options are already a choice. */
export const gateNotYetLabel = (gate: Pick<AgendaGate, 'options'>): string | undefined => {
  if (gate.options.length !== 1) return undefined;
  const taken = gate.options.some(option => option.label.trim().toLowerCase() === GATE_NOT_YET_LABEL.toLowerCase());
  return taken ? GATE_NOT_YET_FALLBACK : GATE_NOT_YET_LABEL;
};

const isForward = (option: AgendaGateOption): boolean => option.outcome !== 'reopen-with-agenda';

/**
 * Which label each swipe gives (the wire contract, the owner's rule for task cards: ← Done, → Not good): ← the first
 * option that moves the card on (next, a lane, close), → the reopen-with-agenda option (else "Not yet"), ↑ a third.
 * Two answers are ← and → only, as every choice card lays two options out.
 */
const gateLayout = (gate: Pick<AgendaGate, 'options'>): ReadonlyMap<AgendaDirection, string> => {
  const notYet = gateNotYetLabel(gate);
  const labels = [...gate.options.map(option => option.label), ...(notYet === undefined ? [] : [notYet])];
  const forward = gate.options.find(isForward)?.label;
  const back = gate.options.find(option => !isForward(option))?.label ?? notYet;
  const rest = labels.filter(label => label !== forward && label !== back);
  const left = forward ?? rest.shift();
  const right = back ?? rest.shift();
  const up = rest.shift();
  return new Map(
    (
      [
        ['left', left],
        ['up', up],
        ['right', right],
      ] as const
    ).flatMap(([direction, label]) => (label === undefined ? [] : [[direction, label] as const])),
  );
};

/**
 * The ask's options, in SWIPE order — ← first, then ↑, then → — because a choice card lays its options out in the
 * order of its ask. `gate.options` keeps the lane's own order; "Not yet" is the one label it does not hold.
 */
export const gateAskOptions = (gate: Pick<AgendaGate, 'options'>): AgendaAskOption[] =>
  [...gateLayout(gate).values()].map(label => ({ label }));

/** The answers, ← · ↑ · →, each `choose`ing its label, so an app that knows nothing of gates answers correctly. */
export const gateAnswers = (gate: Pick<AgendaGate, 'options'>): AgendaCardAnswer[] =>
  [...gateLayout(gate)].map(([direction, label]) => ({ direction, label, does: 'choose' as const }));

/** What a chosen label means on this gate: one of its options, "Not yet", or nothing it offers. */
export type GateChoice =
  | { readonly kind: 'option'; readonly option: AgendaGateOption }
  | { readonly kind: 'not-yet' }
  | { readonly kind: 'unknown' };

/** The gate's reading of the label the owner chose, compared as the agenda compares option labels. Total. */
export const gateChoice = (gate: Pick<AgendaGate, 'options'>, label: string): GateChoice => {
  const wanted = label.trim();
  const option = gate.options.find(candidate => candidate.label.trim() === wanted);
  if (option !== undefined) return { kind: 'option', option };
  return gateNotYetLabel(gate) === wanted ? { kind: 'not-yet' } : { kind: 'unknown' };
};

/** The gate's reopen-with-agenda option, when it has one: what an answer in the owner's own words means. */
export const gateReopenOption = (gate: Pick<AgendaGate, 'options'>): AgendaGateOption | undefined =>
  gate.options.find(option => option.outcome === 'reopen-with-agenda');
