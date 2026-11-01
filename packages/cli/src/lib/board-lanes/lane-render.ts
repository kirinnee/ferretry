import {
  ADMIN_TOKEN_ACTOR_WORDS,
  type BoardProject,
  type BoardSwitch,
  type LaneSet,
  type LaneSetChangeResponse,
  laneUse,
} from '@ferretry/protocol';

/** The lanes in order: each one's id (to name it in `--rename`, `--remove` and `task move`) and when a card belongs there. */
export function renderLaneSet(laneSet: LaneSet, projectName: string): string {
  const state =
    laneSet.confirmedBy === null
      ? `proposed by ${laneSet.proposedBy}, not yet confirmed`
      : laneSet.confirmedVia === 'admin-token'
        ? `confirmed by ${ADMIN_TOKEN_ACTOR_WORDS}`
        : 'confirmed by the owner';
  const rows = laneSet.lanes.map(lane => {
    const gate = lane.ownerGate === true ? ', owner-gated' : '';
    return `  ${lane.id}\t${lane.name}\t(${lane.category}${gate})\tuse when: ${laneUse(lane)}`;
  });
  return [`${projectName} lanes, version ${String(laneSet.version)} — ${state}`, ...rows].join('\n');
}

/** One board: its lanes, or the fact that it has none and the way to get some. */
export function renderBoardLanes(project: BoardProject, binary: string): string {
  return project.laneSet === null
    ? `${project.name} has no lanes yet. Propose them: ${binary} board lanes propose --template <template> --project ${project.name}`
    : renderLaneSet(project.laneSet, project.name);
}

/** What a change did, and whether the owner was asked. */
export function renderLaneChange(change: LaneSetChangeResponse, projectName: string): string {
  const note: Record<LaneSetChangeResponse['agenda'], string> = {
    raised: 'The owner has one Accept / Edit choice on the agenda.',
    'not-needed': 'No question for the owner is needed.',
    failed: 'The lanes are live, but the agenda choice could not be raised — tell the owner yourself.',
  };
  return `${renderLaneSet(change.laneSet, projectName)}\n${note[change.agenda]}`;
}

/** Whether a project uses the board, who decided, and what that means for a ferret there. */
export function renderBoardSwitch(state: BoardSwitch, projectName: string, binary: string): string {
  const who: Record<BoardSwitch['setBy'], string> = {
    default: 'nobody switched it on',
    migration: `set when the board became opt-in (${state.setAt ?? 'unknown'})`,
    owner: `set by the owner (${state.setAt ?? 'unknown'})`,
  };
  const meaning = state.on
    ? 'Ferrets here keep a card for their work.'
    : `Ferrets here make no card unless the owner asks for one or their lead hands them one. Switch it on: ${binary} board on --project ${projectName}`;
  return `${projectName}: board ${state.on ? 'on' : 'off'} — ${who[state.setBy]}.\n${meaning}`;
}
