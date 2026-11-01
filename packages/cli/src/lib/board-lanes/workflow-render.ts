import { type BoardProject, type GateOption, type Lane, type LaneSet, laneStage, laneUse } from '@ferretry/protocol';

const laneName = (laneSet: LaneSet, id: string): string => laneSet.lanes.find(lane => lane.id === id)?.name ?? id;

const outcomeWords = (laneSet: LaneSet, option: GateOption): string => {
  const { outcome } = option;
  if (outcome.kind === 'next') return 'the next lane';
  if (outcome.kind === 'lane') return laneName(laneSet, outcome.laneId);
  if (outcome.kind === 'close') return `${laneName(laneSet, laneSet.doneLane)} (closed)`;
  return `${laneName(laneSet, laneSet.notGoodLane)}, with the owner's words`;
};

/** A lane's stage in words: the owner's options for a gate, what moves a card in by itself for the rest. */
const stageWords = (laneSet: LaneSet, lane: Lane): string => {
  const stage = laneStage(lane);
  if (stage.kind === 'gate') {
    return `GATE\t${stage.options.map(option => `${option.label} → ${outcomeWords(laneSet, option)}`).join('; ')}`;
  }
  const enterOn = stage.triggers.length === 0 ? undefined : stage.triggers;
  return `AUTO\t${laneUse({ category: lane.category, ownerGate: false, ...(enterOn === undefined ? {} : { enterOn }) })}`;
};

/** The lanes in order, each one a gate the owner answers or an automatic step. */
export function renderWorkflow(project: BoardProject, binary: string): string {
  const { laneSet } = project;
  if (laneSet === null) {
    return `${project.name} has no lanes yet. Propose them: ${binary} board lanes propose --template <template> --project ${project.name}`;
  }
  const rows = laneSet.lanes.map(lane => `  ${lane.id}\t${lane.name}\t${stageWords(laneSet, lane)}`);
  return [`${project.name} workflow, lanes version ${String(laneSet.version)}`, ...rows].join('\n');
}
