/** The board fixtures the warden's tests build cards from: the classic lanes and a stored card, in Board's own types. */
import type { Card, LaneSet } from '@ferretry/plugin-board/contract';
import type { Instant } from '@ferretry/std';

export const PROJECT = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-31T12:00:00.000Z' as Instant;

export const lanes = (projectId: string = PROJECT): LaneSet => ({
  projectId,
  version: 1,
  confirmedBy: null,
  proposedBy: 'daemon',
  lanes: [
    { id: 'todo', name: 'Todo', category: 'backlog' },
    { id: 'plan', name: 'Plan/Design', category: 'active' },
    { id: 'implement', name: 'Implement', category: 'active' },
    { id: 'review', name: 'Review/CI', category: 'review' },
    { id: 'merged', name: 'Merged', category: 'shipped' },
    { id: 'released', name: 'Released', category: 'shipped' },
    { id: 'tested', name: 'To test', category: 'verify' },
    { id: 'closed', name: 'Closed', category: 'closed' },
  ],
  variants: {},
  doneLane: 'closed',
  notGoodLane: 'implement',
});

const ferret = (id: string) => ({ kind: 'ferret' as const, name: id, ferret: id });

/** A stored card: `F1` by ferret `lead`, in Todo, unless told otherwise. */
export const card = (overrides: Partial<Card> = {}): Card => {
  const id = overrides.id ?? 'F1';
  const laneId = overrides.laneId ?? 'todo';
  return {
    format: 1,
    id,
    machineId: 'machine-1',
    projectId: PROJECT,
    laneId,
    kind: 'feature',
    title: 'Board store',
    summary: '',
    ask: { text: 'build the board', source: 'owner' },
    clarifications: [],
    premise: '',
    context: '',
    terms: [],
    brief: '',
    howToTest: '',
    owner: 'lead',
    assignee: null,
    parent: null,
    dependsOn: [],
    blocked: null,
    dropped: null,
    workflow: 'design-first',
    links: { prs: [], branch: null, commits: [], docs: [] },
    files: [],
    order: null,
    createdAt: NOW,
    createdBy: ferret('lead'),
    history: [{ seq: 1, at: NOW, actor: ferret('lead'), type: 'created', laneId }],
    ...overrides,
  };
};
