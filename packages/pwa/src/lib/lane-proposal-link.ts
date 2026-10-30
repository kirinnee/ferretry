/**
 * WHERE "EDIT" ON A LANE-PROPOSAL CARD GOES. The card is an ordinary agenda choice (Accept / Edit); the
 * daemon only resolves it on Edit, so opening the lane editor is the PWA's part. The card names its project and
 * version in `sourceRef` (`parseLaneProposalReference`), and the choice label is the protocol's own.
 */

import { type AgendaItem, LANE_PROPOSAL_ANSWERS, parseLaneProposalReference } from '@ferretry/protocol';
import type { InboxAction } from './agenda-answers.ts';
import type { DaemonId } from './daemon-connection.ts';
import { daemonProjectLanesPath } from './pages/routes.ts';

/** The lane editor `action` opens, or `undefined` when it is not the Edit answer of a lane-proposal card. */
export const laneEditDestination = (
  daemonId: DaemonId,
  item: Pick<AgendaItem, 'sourceRef'>,
  action: InboxAction,
): string | undefined => {
  if (action.kind !== 'respond' || action.response.kind !== 'multiple-choice') return undefined;
  if (action.response.choice.trim() !== LANE_PROPOSAL_ANSWERS.edit) return undefined;
  const proposal = parseLaneProposalReference(item.sourceRef ?? null);
  return proposal === undefined ? undefined : daemonProjectLanesPath(daemonId, proposal.projectId);
};
