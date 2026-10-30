/**
 * THE AGENDA CARD A LANE PROPOSAL RAISES (docs/agenda.md): one choice for the owner, "Lanes for <project>:
 * A → B → …", with Accept and Edit. The card's words and shape live here, and so does what an answer to it
 * means; raising it is `LaneSetService`'s and answering it is the agenda's.
 *
 * The card is keyed by project AND version, so a set proposed again gets a card of its own and an Accept
 * of an older one names a version that has moved on.
 */
import {
  type AttentionAsk,
  type AttentionCardAnswer,
  type BoardProjectId,
  BoardProjectIdSchema,
  clipAtWord,
  type LaneSet,
  MAX_ATTENTION_SUBJECT_LENGTH,
  type ResolvedAttentionItem,
} from '@ferretry/protocol';

/** The option labels ARE the decision, so a client that knows nothing of lanes answers correctly by choosing. */
export const LANE_PROPOSAL_ANSWERS = { accept: 'Accept', edit: 'Edit' } as const;

const REFERENCE_PREFIX = 'lanes:';

export const laneProposalReference = (projectId: BoardProjectId, version: number): string =>
  `${REFERENCE_PREFIX}${projectId}:${String(version)}`;

export interface LaneProposalCard {
  readonly subject: string;
  readonly title: string;
  readonly kind: 'choice';
  readonly ask: AttentionAsk;
  readonly answers: AttentionCardAnswer[];
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
    subject: clipAtWord(`Lanes for ${projectName}: ${path}`, MAX_ATTENTION_SUBJECT_LENGTH),
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
 * The project and version an Accept confirms, or `undefined` for any answer that confirms nothing: another
 * card, a dismissal, Edit, or the owner's own words.
 */
export const acceptedProposal = (
  addressed: ResolvedAttentionItem,
): { readonly projectId: BoardProjectId; readonly version: number } | undefined => {
  const { sourceRef, response } = addressed;
  if (sourceRef === null || !sourceRef.startsWith(REFERENCE_PREFIX)) return undefined;
  if (response?.kind !== 'multiple-choice' || response.choice.trim() !== LANE_PROPOSAL_ANSWERS.accept) return undefined;
  const separator = sourceRef.lastIndexOf(':');
  const version = Number(sourceRef.slice(separator + 1));
  const projectId = sourceRef.slice(REFERENCE_PREFIX.length, separator);
  if (!Number.isSafeInteger(version) || version < 1 || projectId === '') return undefined;
  const parsed = BoardProjectIdSchema.safeParse(projectId);
  return parsed.success ? { projectId: parsed.data, version } : undefined;
};
