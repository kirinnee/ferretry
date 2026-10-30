import type { BoardProject, LaneSet, LaneSetChangeResponse } from '@ferretry/protocol';

/** The lanes in order, with each one's id so a person can name it in `--rename` and `--remove`. */
export function renderLaneSet(laneSet: LaneSet, projectName: string): string {
  const state =
    laneSet.confirmedBy === null ? `proposed by ${laneSet.proposedBy}, not yet confirmed` : 'confirmed by the owner';
  const rows = laneSet.lanes.map(lane => {
    const gate = lane.ownerGate === true ? ', owner-gated' : '';
    return `  ${lane.id}\t${lane.name}\t(${lane.category}${gate})`;
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
