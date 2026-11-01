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
  laneChangeWarnings,
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
  readonly why: string;
  readonly howToResolve: string;
}

export const laneProposalCard = (projectName: string, laneSet: LaneSet): LaneProposalCard => {
  const accept = { label: LANE_PROPOSAL_ANSWERS.accept, description: 'Keep these lanes; the board stays as it is' };
  const edit = {
    label: LANE_PROPOSAL_ANSWERS.edit,
    description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
  };
  const path = laneSet.lanes.map(lane => lane.name).join(' → ');
  return {
    subject: clipAtWord(`Lanes for ${projectName}: ${path}`, MAX_AGENDA_SUBJECT_LENGTH),
    title: clipAtWord(`Lanes for ${projectName}`, 60),
    kind: 'choice',
    ask: { kind: 'multiple-choice', options: [accept, edit] },
    answers: [
      { direction: 'right', does: 'choose', ...accept },
      { direction: 'left', does: 'choose', ...edit },
    ],
    why: `${laneSet.proposedBy} proposed these lanes for ${projectName}. They are live already; nothing waits on you.`,
    howToResolve:
      'Choose Accept to keep the lanes. Choose Edit to change them in the Board lane editor, which confirms them when you save.',
  };
};

/**
 * The card a ferret's change to lanes the project already has raises (`docs/board.md` § A ferret's lane change
 * waits for the owner): the proposed lanes, what they would do that only the owner may decide
 * ({@link laneChangeWarnings}), and that NOTHING changes until the owner accepts.
 */
export const laneChangeCard = (projectName: string, live: LaneSet, pending: PendingLaneSet): LaneProposalCard => {
  const accept = { label: LANE_PROPOSAL_ANSWERS.accept, description: 'Switch the board to these lanes' };
  const edit = {
    label: LANE_PROPOSAL_ANSWERS.edit,
    description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
  };
  const path = pending.lanes.map(lane => lane.name).join(' → ');
  const warnings = laneChangeWarnings(live, pending);
  const said = warnings.length === 0 ? '' : ` It would: ${warnings.join('; ')}.`;
  return {
    subject: clipAtWord(`Lanes for ${projectName}: ${path}`, MAX_AGENDA_SUBJECT_LENGTH),
    title: clipAtWord(`Lanes for ${projectName}`, 60),
    kind: 'choice',
    ask: { kind: 'multiple-choice', options: [accept, edit] },
    answers: [
      { direction: 'right', does: 'choose', ...accept },
      { direction: 'left', does: 'choose', ...edit },
    ],
    why: clipAtWord(
      `${pending.proposedBy} proposes new lanes for ${projectName}. The board keeps its lanes until you accept.${said}`,
      MAX_AGENDA_DETAIL_LENGTH,
    ),
    howToResolve:
      'Choose Accept to switch the board to these lanes; any cards they move, move then. Choose Edit to change them in the Board lane editor; the board keeps its lanes until you save.',
  };
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
