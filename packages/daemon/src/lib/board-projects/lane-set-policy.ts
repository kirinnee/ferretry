/**
 * HOW A PROJECT'S LANE SET CHANGES (`board-design.md` §2.3). Pure and total: every function returns a
 * {@link BoardResult}, and the storage and the agenda are somebody else's.
 *
 * - **propose** stores an UNCONFIRMED set that is live at once. It is refused once the owner has confirmed a
 *   set: from then on lanes change by an edit against the version the editor saw.
 * - **edit** is checked against that version. Lanes it removes must say where their cards go, and a lane
 *   that stays keeps its id however it is renamed. An edit by the owner confirms the set; an edit by a
 *   ferret leaves it a proposal for the owner to look at again.
 * - An edit keeps the set's Done and Not good lanes while they still fit, unless it names its own
 *   (`laneTargets`); an app that predates them never resets them.
 * - **confirm** is the owner's accept: the lanes and the version stay as they are.
 * - **merge the release lanes** ({@link mergeReleaseLanes}) folds a set's Released and To test lanes into one
 *   at boot: a release is what the owner tests, so the two were one step drawn twice.
 */
import {
  type BoardResult,
  boardErr,
  boardOk,
  LANE_TEMPLATES,
  type Lane,
  type LaneLayoutValue,
  type LaneRenames,
  type LaneSet,
  type LaneTemplateError,
  type LaneTemplateName,
  laneEditProblems,
  laneLayoutFromTemplate,
  laneTargets,
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
  // A layout always has a closed and a backlog lane by now (the schema refused it otherwise), so it has targets.
  const targets = laneTargets(edit.layout, current) ?? { doneLane: current.doneLane, notGoodLane: current.notGoodLane };
  return boardOk({
    projectId: current.projectId,
    version: current.version + 1,
    confirmedBy: actor.kind === 'owner' ? 'owner' : null,
    proposedBy: actor.kind === 'owner' ? current.proposedBy : actor.name,
    ...edit.layout,
    ...targets,
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

/** The merged lane's name: what the owner reads, whatever the two lanes were called. */
export const RELEASED_TO_TEST_NAME = 'Released · to test';

/** What merging a set's Released and To test lanes comes to: the set to store, and where cards move. */
export interface ReleaseLaneMerge {
  readonly next: LaneSet;
  /** The To test lane that is gone. */
  readonly from: string;
  /** The Released lane every card of both now sits in. */
  readonly into: string;
}

/**
 * Folds a set's Released lane (a `shipped` lane entered on `release.published`) and the To test lane right
 * after it (a `verify` lane entered on `release.running`) into one: the Released lane's id and place, named
 * {@link RELEASED_TO_TEST_NAME}, a `verify` lane entered on release, gated the way To test was. Variants
 * walk it where they walked either. The set's version rises and its confirmation stands: a merge is not a
 * new proposal, so the owner is asked nothing. `null` when there is nothing to merge, so it is idempotent.
 */
export const mergeReleaseLanes = (current: LaneSet): ReleaseLaneMerge | null => {
  const at = current.lanes.findIndex(
    (lane, index) =>
      lane.category === 'shipped' &&
      lane.enterOn?.includes('release.published') === true &&
      current.lanes[index + 1]?.category === 'verify' &&
      current.lanes[index + 1]?.enterOn?.includes('release.running') === true,
  );
  const released = current.lanes[at];
  const tested = current.lanes[at + 1];
  if (at === -1 || released === undefined || tested === undefined) return null;
  // Never empty: the Released lane was found by its `release.published`.
  const enterOn = [
    ...new Set(
      [...(released.enterOn ?? []), ...(tested.enterOn ?? [])].filter(trigger => trigger !== 'release.running'),
    ),
  ];
  const merged: Lane = {
    id: released.id,
    name: RELEASED_TO_TEST_NAME,
    category: 'verify',
    enterOn,
    ...(tested.ownerGate === undefined ? {} : { ownerGate: tested.ownerGate }),
    emphasis: 'action',
  };
  const lanes = current.lanes.flatMap((lane, index) => {
    if (index === at) return [merged];
    return index === at + 1 ? [] : [lane];
  });
  const variants = Object.fromEntries(
    Object.entries(current.variants).map(([workflow, ids]) => [
      workflow,
      [...new Set((ids ?? []).map(id => (id === tested.id ? released.id : id)))],
    ]),
  );
  const layout = { lanes, variants };
  const targets = laneTargets(layout, current) ?? { doneLane: current.doneLane, notGoodLane: current.notGoodLane };
  return {
    next: { ...current, version: current.version + 1, ...layout, ...targets },
    from: tested.id,
    into: released.id,
  };
};
