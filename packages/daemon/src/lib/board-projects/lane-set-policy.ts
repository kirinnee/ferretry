/**
 * HOW A PROJECT'S LANE SET CHANGES (`board-design.md` §2.3). Pure and total: every function returns a
 * {@link BoardResult}, and the storage and the agenda are somebody else's.
 *
 * - **propose** stores an UNCONFIRMED set that is live at once. It is refused once the owner has confirmed a
 *   set: from then on lanes change by an edit against the version the editor saw.
 * - **edit** is checked against that version. Lanes it removes must say where their cards go, and a lane
 *   that stays keeps its id however it is renamed. An edit by the owner confirms the set; an edit by a
 *   ferret leaves it a proposal for the owner to look at again.
 * - **confirm** is the owner's accept: the lanes and the version stay as they are.
 */
import {
  type BoardResult,
  boardErr,
  boardOk,
  LANE_TEMPLATES,
  type LaneLayoutValue,
  type LaneRenames,
  type LaneSet,
  type LaneTemplateError,
  type LaneTemplateName,
  laneEditProblems,
  laneLayoutFromTemplate,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';

/** Who is changing the lanes. */
export type LaneActor =
  | { readonly kind: 'owner' }
  | { readonly kind: 'ferret'; readonly name: string; readonly sessionId: string };

export type LaneSetProblem =
  | LaneTemplateError
  | { readonly code: 'version-conflict'; readonly current: number }
  | { readonly code: 'no-lane-set' }
  | { readonly code: 'owner-only' }
  | { readonly code: 'already-confirmed'; readonly version: number }
  | { readonly code: 'relocation-missing'; readonly laneIds: readonly string[] };

export const actorName = (actor: LaneActor): string => (actor.kind === 'owner' ? 'owner' : actor.name);

/** The Unfiled board's lanes until the owner edits them: the `quick` template, already confirmed. */
export const unfiledLaneSet = (): LaneSet => ({
  projectId: UNFILED_PROJECT_ID,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'ferretry',
  ...LANE_TEMPLATES.quick,
});

export const proposeLaneSet = (
  projectId: LaneSet['projectId'],
  current: LaneSet | null,
  template: LaneTemplateName,
  renames: LaneRenames,
  proposedBy: string,
): BoardResult<LaneSet, LaneSetProblem> => {
  if (current?.confirmedBy === 'owner') return boardErr({ code: 'already-confirmed', version: current.version });
  const layout = laneLayoutFromTemplate(template, renames);
  if (!layout.ok) return layout;
  return boardOk({ projectId, version: (current?.version ?? 0) + 1, confirmedBy: null, proposedBy, ...layout.value });
};

export const editLaneSet = (
  current: LaneSet | null,
  edit: {
    readonly version: number;
    readonly layout: LaneLayoutValue;
    readonly relocate: Partial<Record<string, string>>;
  },
  actor: LaneActor,
): BoardResult<LaneSet, LaneSetProblem> => {
  if (current === null) return boardErr({ code: 'no-lane-set' });
  if (edit.version !== current.version) return boardErr({ code: 'version-conflict', current: current.version });
  const unplaced = laneEditProblems(current, edit);
  if (unplaced.length > 0) return boardErr({ code: 'relocation-missing', laneIds: unplaced });
  return boardOk({
    projectId: current.projectId,
    version: current.version + 1,
    confirmedBy: actor.kind === 'owner' ? 'owner' : null,
    proposedBy: actor.kind === 'owner' ? current.proposedBy : actor.name,
    ...edit.layout,
  });
};

export const confirmLaneSet = (current: LaneSet | null, version: number): BoardResult<LaneSet, LaneSetProblem> => {
  if (current === null) return boardErr({ code: 'no-lane-set' });
  if (version !== current.version) return boardErr({ code: 'version-conflict', current: current.version });
  return boardOk({ ...current, confirmedBy: 'owner' });
};

/** What a card-creating command says when a project has no lanes: the exact command to run next. */
export const noLaneSetMessage = (project: string, binary: string): string =>
  `${project} has no lanes yet. Propose them first: ${binary} board lanes propose --template ` +
  `${Object.keys(LANE_TEMPLATES).join('|')} --project ${project}`;

/** A refusal in words a person or a ferret can act on. */
export const describeLaneSetFailure = (
  failure: LaneSetProblem | { readonly code: 'not-found'; readonly projectId: string },
): string => {
  switch (failure.code) {
    case 'not-found':
      return `no board for project ${failure.projectId}`;
    case 'unknown-lane':
      return `the template has no lane ${failure.laneId}, so it cannot be renamed`;
    case 'relocation-missing':
      return `lanes ${failure.laneIds.join(', ')} are removed without saying where their cards go`;
    case 'version-conflict':
      return `the lanes are at version ${String(failure.current)} now; read them again and retry`;
    case 'already-confirmed':
      return `the owner already confirmed these lanes (version ${String(failure.version)}); edit them instead of proposing`;
    case 'no-lane-set':
      return 'this project has no lanes yet; propose them first';
    case 'owner-only':
      return 'only the owner confirms lanes';
  }
};
