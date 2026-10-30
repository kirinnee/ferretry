import { type BoardProject, type BoardProjectsResponse, LANE_TEMPLATES, type LaneSet } from '@ferretry/protocol';

export const FERRETRY_ID = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10';

export const laneSet = (overrides: Partial<LaneSet> = {}): LaneSet => ({
  projectId: FERRETRY_ID as LaneSet['projectId'],
  version: 3,
  confirmedBy: null,
  proposedBy: 'denisha',
  ...LANE_TEMPLATES.pr,
  ...overrides,
});

export const project = (overrides: Partial<BoardProject> = {}): BoardProject => ({
  id: FERRETRY_ID as BoardProject['id'],
  name: 'Ferretry',
  path: '/work/ferretry',
  laneSet: laneSet(),
  ...overrides,
});

export const listing = (overrides: Partial<BoardProjectsResponse> = {}): BoardProjectsResponse => ({
  projects: [project({ id: 'unfiled' as BoardProject['id'], name: 'Unfiled', path: null, laneSet: null }), project()],
  current: null,
  ...overrides,
});
