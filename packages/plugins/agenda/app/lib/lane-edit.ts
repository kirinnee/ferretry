/**
 * WHERE "EDIT" ON A LANE-PROPOSAL CARD GOES (copied from today's `lib/lane-proposal-link.ts`). The card is an ordinary
 * agenda choice (Accept / Edit); the daemon only resolves it on Edit, so opening the lane editor is the app's part. The
 * card names its project and version in `sourceRef` (`lanes:<project>:<version>`, Board's spelling), and the editor is
 * Board's page, which the caller spells (`laneEditor`), so this half hard-codes no Board path. Pure.
 */

import type { AgendaItem } from '../wire/index.ts';
import type { InboxAction } from './agenda-inbox.ts';

/** The choice labels of a lane-proposal card (Board's `LANE_PROPOSAL_ANSWERS`). */
export const LANE_PROPOSAL_ANSWERS = { accept: 'Accept', edit: 'Edit' } as const;

const LANE_PROPOSAL_REFERENCE_PREFIX = 'lanes:';

/** The project a lane-proposal `sourceRef` names, or `undefined` for any other reference. */
export const laneProposalProject = (sourceRef: string | null): string | undefined => {
  if (sourceRef === null || !sourceRef.startsWith(LANE_PROPOSAL_REFERENCE_PREFIX)) return undefined;
  const separator = sourceRef.lastIndexOf(':');
  const version = Number(sourceRef.slice(separator + 1));
  const projectId = sourceRef.slice(LANE_PROPOSAL_REFERENCE_PREFIX.length, separator);
  return !Number.isSafeInteger(version) || version < 1 || projectId === '' ? undefined : projectId;
};

/** The lane editor `action` opens, or `undefined` when it is not the Edit answer of a lane-proposal card. */
export const laneEditDestination = (
  item: Pick<AgendaItem, 'sourceRef'>,
  action: InboxAction,
  laneEditor: ((projectId: string) => string | undefined) | undefined,
): string | undefined => {
  if (laneEditor === undefined) return undefined;
  if (action.kind !== 'respond' || action.response.kind !== 'multiple-choice') return undefined;
  if (action.response.choice.trim() !== LANE_PROPOSAL_ANSWERS.edit) return undefined;
  const project = laneProposalProject(item.sourceRef ?? null);
  return project === undefined ? undefined : laneEditor(project);
};
