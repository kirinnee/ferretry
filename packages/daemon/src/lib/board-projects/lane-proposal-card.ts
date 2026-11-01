/**
 * THE AGENDA CARD A LANE PROPOSAL RAISES (docs/agenda.md): one choice for the owner, "Lanes for <project>:
 * A → B → …", with Accept and Edit. The card's words and shape live here, and so does what an answer to it
 * means; raising it is `LaneSetService`'s and answering it is the agenda's.
 *
 * The card is keyed by project AND version, so a set proposed again gets a card of its own and an Accept
 * of an older one names a version that has moved on.
 */
import {
  type AgendaAsk,
  type AgendaCardAnswer,
  type BoardProjectId,
  clipAtWord,
  LANE_PROPOSAL_ANSWERS,
  laneChangeLines,
  type LaneSet,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
  type PendingLaneSet,
  parseLaneProposalReference,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';

export interface LaneProposalCard {
  readonly subject: string;
  readonly title: string;
  readonly kind: 'choice';
  readonly ask: AgendaAsk;
  readonly answers: AgendaCardAnswer[];
  /**
   * One line — who proposes what, and that the board waits for the owner — then, on a change that decides
   * something, a Markdown list of what accepting it would do, one bullet per thing: the card draws its why.
   */
  readonly why: string;
  /** Edit, on a card whose change does something the owner decides: read it before accepting it. */
  readonly recommendation?: { readonly decision: string; readonly why: string };
  readonly howToResolve: string;
}

const EDIT = {
  label: LANE_PROPOSAL_ANSWERS.edit,
  description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
};

/**
 * A lane card's answers, ← and →, in the owner's one model (→ is yes): Accept on the right, Edit on the left, or, on
 * a card with no Accept, Later on the left and Edit on the right.
 */
const answered = (
  left: { readonly label: string; readonly description: string },
  right: { readonly label: string; readonly description: string },
): Pick<LaneProposalCard, 'ask' | 'answers'> => ({
  ask: { kind: 'multiple-choice', options: [left, right] },
  answers: [
    { direction: 'left', does: 'choose', ...left },
    { direction: 'right', does: 'choose', ...right },
  ],
});

export const laneProposalCard = (projectName: string, laneSet: LaneSet): LaneProposalCard => {
  const accept = { label: LANE_PROPOSAL_ANSWERS.accept, description: 'Keep these lanes; the board stays as it is' };
  const path = laneSet.lanes.map(lane => lane.name).join(' → ');
  return {
    subject: clipAtWord(`Lanes for ${projectName}: ${path}`, MAX_AGENDA_SUBJECT_LENGTH),
    title: clipAtWord(`Lanes for ${projectName}`, 60),
    kind: 'choice',
    ...answered(EDIT, accept),
    why: `${laneSet.proposedBy} proposed these lanes for ${projectName}. They are live already; nothing waits on you.`,
    howToResolve:
      'Choose Accept to keep the lanes. Choose Edit to change them in the Board lane editor, which confirms them when you save.',
  };
};

/** How long a proposer's name may run on the card, so it never crowds out what the change would do. */
export const MAX_PROPOSER_NAME = 60;

/** The answer of a card with no Accept that leaves the proposal waiting. Never an Accept, so it confirms nothing. */
export const LANE_CHANGE_LATER = 'Later';

/** Why a card whose change decides something recommends Edit. */
export const LANE_CHANGE_READ_FIRST = 'It changes what only you decide: read it in the lane editor before you accept.';

/**
 * The card a ferret's change to lanes the project already has raises (`docs/board.md` § A ferret's lane change
 * waits for the owner): one line saying who proposes it and that NOTHING changes until the owner accepts, then
 * everything it would do that only the owner decides as a bullet list under it (`laneChangeLines`: like removals
 * told once).
 * Then Edit is recommended. A bullet is never cut short: the ones that do not fit are counted — and then the card has
 * no Accept, so a change the owner has not read in full is accepted only in the lane editor, which lists it all.
 */
export const laneChangeCard = (projectName: string, live: LaneSet, pending: PendingLaneSet): LaneProposalCard => {
  const accept = { label: LANE_PROPOSAL_ANSWERS.accept, description: 'Switch the board to these lanes' };
  const later = { label: LANE_CHANGE_LATER, description: 'Leave it waiting; the board keeps its lanes' };
  const path = pending.lanes.map(lane => lane.name).join(' → ');
  const lines = laneChangeLines(live, pending, pending.relocate);
  const proposer = clipAtWord(pending.proposedBy, MAX_PROPOSER_NAME);
  const opening = `${proposer} proposes new lanes for ${clipAtWord(projectName, MAX_PROPOSER_NAME)}. The board keeps its lanes until you accept.`;
  const { why, hidden } = bullets(`${opening} Accepting it:`, lines);
  return {
    subject: clipAtWord(`Lanes for ${projectName}: ${path}`, MAX_AGENDA_SUBJECT_LENGTH),
    title: clipAtWord(`Lanes for ${projectName}`, 60),
    kind: 'choice',
    ...(hidden ? answered(later, EDIT) : answered(EDIT, accept)),
    why: lines.length === 0 ? opening : why,
    ...(lines.length === 0 || hidden ? {} : { recommendation: { decision: EDIT.label, why: LANE_CHANGE_READ_FIRST } }),
    howToResolve: hidden
      ? 'It does more than a card can show, so it is accepted in the Board lane editor, where every part of it is listed. Choose Edit to go there; the board keeps its lanes until you accept.'
      : 'Choose Accept to switch the board to these lanes; any cards they move, move then. Choose Edit to change them in the Board lane editor; the board keeps its lanes until you save.',
  };
};

/**
 * The intro and, under it, the bullets that fit a card, WHOLE, and a last one counting the rest; `hidden`: some did
 * not fit. One always fits: a lane's name is at most 40 characters, so a line is a few hundred at most.
 */
const bullets = (intro: string, lines: readonly string[]): { readonly why: string; readonly hidden: boolean } => {
  const say = (shown: readonly string[]): string => {
    const hidden = lines.length - shown.length;
    const more = hidden === 0 ? [] : [`and ${String(hidden)} more, all in the Board lane editor`];
    return `${intro}\n\n${[...shown, ...more].map(line => `- ${line}`).join('\n')}`;
  };
  let shown = [...lines];
  while (shown.length > 1 && say(shown).length > MAX_AGENDA_DETAIL_LENGTH) shown = shown.slice(0, -1);
  return { why: say(shown), hidden: shown.length < lines.length };
};

/**
 * The project and version an Accept confirms, or `undefined` for any answer that confirms nothing: another
 * card, a dismissal, Edit, or the owner's own words.
 */
/** The agenda source a lane proposal's card is raised under: the producer an Accept must come from. */
export const LANE_PROPOSAL_SOURCE = 'task';

export const acceptedProposal = (
  addressed: ResolvedAgendaItem,
): { readonly projectId: BoardProjectId; readonly version: number } | undefined => {
  const { sourceRef, response } = addressed;
  // Only the lane producer's own card: a reference alone could be written by anything else (docs/agenda.md §
  // Reserved sourceRefs), and an Accept confirms lanes as the owner.
  if (addressed.raisedBy !== 'daemon' || addressed.source !== LANE_PROPOSAL_SOURCE) return undefined;
  if (response?.kind !== 'multiple-choice' || response.choice.trim() !== LANE_PROPOSAL_ANSWERS.accept) return undefined;
  return parseLaneProposalReference(sourceRef);
};
