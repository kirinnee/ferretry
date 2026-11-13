import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import type { BoardProjectId } from '../../../contract/index.ts';
import { WorkflowSchema } from '../../../contract/index.ts';
import {
  defaultLaneTargets,
  LANE_TEMPLATES,
  type Lane,
  type LaneSet,
  type LaneTemplateName,
} from '../../../daemon/lib/lanes/index.ts';

export const FERRETRY_ID = '11111111-1111-4111-8111-111111111111';
export const DOCS_ID = '22222222-2222-4222-8222-222222222222';

export function project(id: string, path: string, commonDirectory?: string): ProjectInfo {
  return {
    id,
    name: path.split('/').pop() ?? path,
    path,
    source: 'existing-folder',
    createdAt: '2026-08-04T00:00:00.000Z',
    ...(commonDirectory === undefined ? {} : { git: { commonDirectory } }),
  } as unknown as ProjectInfo;
}

// Hand-made PR layouts with a Review/CI lane and a To test lane: valid lane sets the engine's rules still run over.
const todo: Lane = { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d' };
const plan: Lane = {
  id: 'plan',
  name: 'Plan/Design',
  category: 'active',
  enterOn: ['work.started'],
  ownerGate: true,
  staleAfter: '2h',
};
const implement: Lane = {
  id: 'implement',
  name: 'Implement',
  category: 'active',
  enterOn: ['work.started'],
  staleAfter: '2h',
};
const review: Lane = {
  id: 'review',
  name: 'Review/CI',
  category: 'review',
  enterOn: ['pr.opened', 'pr.ready', 'signal.done'],
  staleAfter: '24h',
};
const merged: Lane = { id: 'merged', name: 'Merged', category: 'shipped', enterOn: ['pr.merged'], staleAfter: '3d' };
const released: Lane = { id: 'released', name: 'Released', category: 'shipped', enterOn: ['release.published'] };
const tested: Lane = {
  id: 'tested',
  name: 'To test',
  category: 'verify',
  enterOn: ['release.running'],
  ownerGate: true,
};
const closed: Lane = { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true };

const classicVariants = (layout: readonly Lane[]): LaneSet['variants'] => {
  const ids = layout.map(lane => lane.id);
  return {
    ...Object.fromEntries(WorkflowSchema.options.map(workflow => [workflow, [...ids]])),
    quick: ids.filter(id => id !== 'plan'),
  };
};

const classic = (layout: readonly Lane[]): Pick<LaneSet, 'lanes' | 'variants'> => ({
  lanes: [...layout],
  variants: classicVariants(layout),
});

const CLASSIC_LAYOUTS = {
  'pr-release-verify': classic([todo, plan, implement, review, merged, released, tested, closed]),
  'pr-release': classic([
    todo,
    plan,
    implement,
    review,
    merged,
    { id: 'released', name: 'Released', category: 'closed', enterOn: ['release.published'] },
  ]),
  pr: classic([
    todo,
    plan,
    implement,
    review,
    { id: 'merged', name: 'Merged', category: 'closed', enterOn: ['pr.merged'] },
  ]),
} as const satisfies Partial<Record<LaneTemplateName, Pick<LaneSet, 'lanes' | 'variants'>>>;

/** A lane set from the live template, on a project. */
export const templateLanes = (
  projectId: BoardProjectId = FERRETRY_ID,
  template: LaneTemplateName = 'pr-release-verify',
): LaneSet => ({
  projectId,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'lead',
  ...LANE_TEMPLATES[template],
  lanes: [...LANE_TEMPLATES[template].lanes],
});

/**
 * A lane set on a project: the PR templates in their Review/CI and To test shape, every other template as it ships.
 * {@link templateLanes} is the live template.
 */
export const lanes = (
  projectId: BoardProjectId = FERRETRY_ID,
  template: LaneTemplateName = 'pr-release-verify',
): LaneSet => {
  const layout = template in CLASSIC_LAYOUTS ? CLASSIC_LAYOUTS[template as keyof typeof CLASSIC_LAYOUTS] : undefined;
  if (layout === undefined) return templateLanes(projectId, template);
  const targets = defaultLaneTargets(layout.lanes);
  if (targets === undefined) throw new Error(`the ${template} layout has no Done or Not good lane`);
  return { projectId, version: 1, confirmedBy: 'owner', proposedBy: 'lead', ...layout, ...targets };
};
