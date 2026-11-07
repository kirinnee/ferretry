import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';
import {
  AT,
  card,
  cardResponse,
  DENISHA,
  FERRETRY_ID,
  laneSet,
  listing,
  otherProject,
  project,
  response,
} from '../unit/cli/fixtures.ts';
import { run } from '../integration/cli/harness.ts';

const declared = new Set<string>(manifest.actions?.cli?.map(entry => entry.verb) ?? []);

const PROJECTS = listing({ projects: [project(), otherProject()], current: FERRETRY_ID as never });
const CARD = cardResponse(card({ id: 'F7' }), laneSet());
const BASE = {
  'GET /v1/board/projects': PROJECTS,
  'GET /v1/ferrets': [{ id: DENISHA, name: 'denisha' }],
  'GET /v1/board/cards/:cardId': CARD,
  'POST /v1/board/cards/:cardId': CARD,
};
const LANES = { ...BASE, 'GET /v1/board/projects/:projectId/lanes': project() };
const CHANGE = { 'POST /v1/board/projects/:projectId/lanes': { laneSet: laneSet({ version: 4 }), ask: 'raised' } };
const SWITCH = (on: boolean) => ({
  'GET /v1/board/projects/:projectId/switch': { projectId: FERRETRY_ID, on, setBy: 'owner', setAt: AT },
  'PUT /v1/board/projects/:projectId/switch': { projectId: FERRETRY_ID, on, setBy: 'owner', setAt: AT },
});

type Options = Record<string, string | boolean | readonly string[]>;
interface Row {
  readonly id: string;
  readonly verb: string;
  readonly args?: string[];
  readonly options?: Options;
  readonly answers?: Record<string, unknown>;
  /** The route the verb reaches, and (for a card write) what its body must hold. */
  readonly route: string;
  readonly body?: object;
  /** Not in the manifest's verb list yet: the half answers it, and the manifest line is the lead's to add. */
  readonly undeclared?: boolean;
}

const WRITE = 'POST /v1/board/cards/:cardId';

const ROWS: readonly Row[] = [
  { id: 'V-0085', verb: 'board', answers: { ...BASE, 'GET /v1/board': response() }, route: 'GET /v1/board' },
  {
    id: 'V-0089',
    verb: 'board lanes propose',
    options: { template: 'pr' },
    answers: { ...LANES, ...CHANGE },
    route: 'POST /v1/board/projects/:projectId/lanes',
    body: { action: 'propose', template: 'pr' },
  },
  { id: 'V-0090', verb: 'board lanes show', answers: LANES, route: 'GET /v1/board/projects/:projectId/lanes' },
  {
    id: 'V-0088',
    verb: 'board lanes edit',
    options: { rename: ['todo=Backlog'] },
    answers: { ...LANES, ...CHANGE },
    route: 'POST /v1/board/projects/:projectId/lanes',
    body: { action: 'edit' },
  },
  {
    id: 'V-0091',
    verb: 'board off',
    answers: { ...LANES, ...SWITCH(false) },
    route: 'PUT /v1/board/projects/:projectId/switch',
    body: { on: false },
    undeclared: true,
  },
  {
    id: 'V-0092',
    verb: 'board on',
    answers: { ...LANES, ...SWITCH(true) },
    route: 'PUT /v1/board/projects/:projectId/switch',
    body: { on: true },
    undeclared: true,
  },
  {
    id: 'V-0093',
    verb: 'board status',
    answers: { ...LANES, ...SWITCH(true) },
    route: 'GET /v1/board/projects/:projectId/switch',
  },
  { id: 'V-0096', verb: 'board workflow show', answers: LANES, route: 'GET /v1/board/projects/:projectId/lanes' },
  {
    id: 'V-0095',
    verb: 'board workflow edit',
    options: { lane: 'implement', auto: 'work.started' },
    answers: { ...LANES, ...CHANGE },
    route: 'POST /v1/board/projects/:projectId/lanes',
    body: { action: 'edit' },
  },
  {
    id: 'V-0456',
    verb: 'card adopt',
    args: ['F7'],
    options: { reason: 'its ferret ended' },
    route: WRITE,
    body: { action: 'adopt' },
  },
  {
    id: 'V-0457',
    verb: 'card assign',
    args: ['F7', 'denisha'],
    route: WRITE,
    body: { action: 'assign', assignee: DENISHA },
  },
  {
    id: 'V-0458',
    verb: 'card block',
    args: ['F7', 'waiting', 'on', 'infra'],
    route: WRITE,
    body: { action: 'block', reason: 'waiting on infra' },
  },
  { id: 'V-0459', verb: 'card claim', args: ['F7'], route: WRITE, body: { action: 'claim' } },
  {
    id: 'V-0460',
    verb: 'card clarify',
    args: ['F7', 'also', 'the', 'header'],
    options: { source: 'chat://2' },
    route: WRITE,
    body: { action: 'clarify', text: 'also the header' },
  },
  {
    id: 'V-0461',
    verb: 'card new',
    args: ['Rename', 'widget'],
    options: { kind: 'feature', ask: 'rename it', 'ask-source': 'chat://1', new: true },
    answers: { ...BASE, 'POST /v1/board/cards': CARD },
    route: 'POST /v1/board/cards',
    body: { title: 'Rename widget' },
  },
  {
    id: 'V-0462',
    verb: 'card depend',
    args: ['F7', '&F2'],
    options: { until: 'released' },
    route: WRITE,
    body: { action: 'depend', until: 'released' },
  },
  {
    id: 'V-0463',
    verb: 'card drop',
    args: ['F7'],
    options: { reason: 'moot' },
    route: WRITE,
    body: { action: 'drop', reason: 'moot' },
  },
  {
    id: 'V-0464',
    verb: 'card edit',
    args: ['F7'],
    options: { title: 'New title' },
    route: WRITE,
    body: { action: 'edit', title: 'New title' },
  },
  { id: 'V-0465', verb: 'card file', args: ['F7', 'src/a.ts'], route: WRITE, body: { action: 'file' } },
  { id: 'V-0466', verb: 'card focus', args: ['F7'], route: WRITE, body: { action: 'focus' } },
  {
    id: 'V-0467',
    verb: 'card link',
    args: ['F7'],
    options: { branch: 'feat/x' },
    route: WRITE,
    body: { action: 'link', branch: 'feat/x' },
  },
  {
    id: 'V-0468',
    verb: 'card merge-gate',
    args: ['https://github.com/kirinnee/ferretry/pull/42'],
    answers: { 'GET /v1/board/merge-gate': { pr: 'u', unit: [], waits: [], unreadable: [] } },
    route: 'GET /v1/board/merge-gate',
  },
  {
    id: 'V-0469',
    verb: 'card move',
    args: ['F7', 'implement'],
    options: { reason: 'started' },
    route: WRITE,
    body: { action: 'move', to: 'implement' },
  },
  {
    id: 'V-0470',
    verb: 'card note',
    args: ['F7', 'a', 'note'],
    route: WRITE,
    body: { action: 'note', text: 'a note' },
  },
  { id: 'V-0471', verb: 'card order', args: ['F7', '3'], route: WRITE, body: { action: 'order', order: 3 } },
  {
    id: 'V-0472',
    verb: 'card patch',
    args: ['F7'],
    options: { file: '/f7.yaml' },
    route: WRITE,
    body: { action: 'edit', revision: 1, title: 'Patched' },
  },
  {
    id: 'V-0473',
    verb: 'card refile',
    args: ['F7'],
    options: { project: 'Other' },
    route: WRITE,
    body: { action: 'refile', projectId: project().id === FERRETRY_ID ? otherProject().id : '' },
  },
  {
    id: 'V-0474',
    verb: 'card reopen',
    args: ['F7'],
    options: { to: 'todo', ask: 'it broke again' },
    route: WRITE,
    body: { action: 'reopen' },
  },
  {
    id: 'V-0475',
    verb: 'card reparent',
    args: ['F7'],
    options: { parent: '&F2' },
    route: WRITE,
    body: { action: 'reparent' },
  },
  { id: 'V-0476', verb: 'card show', args: ['F7'], route: 'GET /v1/board/cards/:cardId' },
  {
    id: 'V-0477',
    verb: 'card skip',
    args: ['no', 'card', 'needed'],
    answers: { 'POST /v1/board/skip': { ferret: DENISHA, skip: { reason: 'no card needed', at: AT } } },
    route: 'POST /v1/board/skip',
    body: { reason: 'no card needed' },
  },
  {
    id: 'V-0478',
    verb: 'card trigger',
    args: ['F7', 'deploy.done'],
    route: WRITE,
    body: { action: 'trigger', event: 'deploy.done' },
  },
  {
    id: 'V-0479',
    verb: 'card unblock',
    args: ['F7'],
    options: { reason: 'cleared' },
    route: WRITE,
    body: { action: 'unblock' },
  },
  {
    id: 'V-0480',
    verb: 'card undepend',
    args: ['F7', '&F2'],
    options: { reason: 'moot' },
    route: WRITE,
    body: { action: 'undepend', reason: 'moot' },
  },
];

const bodyOf = (init: unknown): unknown => (init as { body?: unknown } | undefined)?.body;

describe('board command parity', () => {
  for (const row of ROWS) {
    test(`V-${row.id.slice(2)} fy ${row.verb} is ${row.undeclared === true ? 'answered by the half' : 'declared'} and reaches ${row.route}`, async () => {
      if (row.undeclared !== true) expect(declared.has(row.verb)).toBe(true);
      const result = await run(row.verb, {
        ...(row.args === undefined ? {} : { args: row.args }),
        ...(row.options === undefined ? {} : { options: row.options }),
        answers: row.answers ?? BASE,
        files: { '/f7.yaml': 'revision: 1\ntitle: Patched\n' },
      });
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      const reached = result.calls.filter(call => call.route === row.route);
      expect(reached.length).toBeGreaterThan(0);
      if (row.body !== undefined) expect(bodyOf(reached.at(-1)?.init)).toMatchObject(row.body);
    });
  }

  test('V-0087 fy board lanes is the group of propose, show and edit', () => {
    for (const verb of ['board lanes propose', 'board lanes show', 'board lanes edit'])
      expect(declared.has(verb)).toBe(true);
  });

  test('V-0094 fy board workflow is the group of show and edit', () => {
    for (const verb of ['board workflow show', 'board workflow edit']) expect(declared.has(verb)).toBe(true);
  });

  test('V-0455 fy card is the group of every card verb, one per thing fy task had, none of it under the old name', () => {
    const card = [...declared].filter(verb => verb.startsWith('card '));
    expect(card.length).toBeGreaterThanOrEqual(25);
    expect([...declared].filter(verb => verb.startsWith('task'))).toEqual([]);
  });

  test('V-0086 fy board import is removed by design: it is neither declared nor answered (clean slate)', async () => {
    expect(declared.has('board import')).toBe(false);
    await expect(run('board import', { answers: BASE })).rejects.toThrow(/does not implement/u);
  });

  test('V-0461 fy card new is the renamed fy task create: the old name is gone', async () => {
    expect(declared.has('card create')).toBe(false);
    await expect(run('card create', { answers: BASE })).rejects.toThrow(/does not implement/u);
  });

  test('V-0455 fy card has no verb that answers an ask: the agenda asks, the card shows (#1552)', () => {
    expect([...declared].filter(verb => /answer|ask/u.test(verb))).toEqual([]);
  });

  test('V-0464 fy card progress writes the progress the status flags of fy task edit wrote, as one edit with a progress partial', async () => {
    const result = await run('card progress', { args: ['F7'], options: { now: 'testing' }, answers: BASE });
    expect(result.code).toBe(0);
    expect(bodyOf(result.calls.find(call => call.route.startsWith('POST '))?.init)).toEqual({
      action: 'edit',
      progress: { now: 'testing' },
    });
    expect(declared.has('card progress')).toBe(true);
  });
});
