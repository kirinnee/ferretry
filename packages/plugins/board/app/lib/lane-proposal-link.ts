/**
 * WHERE "EDIT" ON A LANE-PROPOSAL ASK GOES. The ask is an ordinary choice (Accept / Edit); the daemon only resolves
 * it on Edit, so opening the lane editor is the app's part. The ask names its project and version in its reference
 * (`parseLaneProposalReference`), and the choice label is the board's own.
 */

import { LANE_PROPOSAL_ANSWERS, parseLaneProposalReference } from '../../contract/index.ts';

/** The one answer shape this reads: a multiple-choice response with the label the owner pressed. */
export interface ChoiceAnswer {
  readonly kind: 'respond';
  readonly response: { readonly kind: 'multiple-choice'; readonly choice: string } | { readonly kind: string };
}

/** The lane editor `action` opens (the project's lanes page), or `undefined` when it is not the Edit answer of a lane proposal. */
export const laneEditDestination = (
  item: { readonly sourceRef?: string | null | undefined },
  action: ChoiceAnswer | { readonly kind: string },
): string | undefined => {
  if (action.kind !== 'respond') return undefined;
  const response = (action as ChoiceAnswer).response;
  if (response.kind !== 'multiple-choice') return undefined;
  if (((response as { readonly choice: string }).choice ?? '').trim() !== LANE_PROPOSAL_ANSWERS.edit) return undefined;
  const proposal = parseLaneProposalReference(item.sourceRef ?? null);
  return proposal === undefined ? undefined : `/projects/${encodeURIComponent(proposal.projectId)}/lanes`;
};
