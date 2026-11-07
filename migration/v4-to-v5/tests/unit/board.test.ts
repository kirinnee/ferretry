import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  BoardFileSchema,
  CardSchema,
  CountersFileSchema,
  FocusFileSchema,
  SweepFileSchema,
} from '@ferretry/plugin-board/contract';
import { readdir, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { boardStep } from '../../src/steps/board.ts';
import { STEPS } from '../../src/steps/index.ts';
import { AT, fixture } from './ferret-fixture.ts';

const MACHINE = 'b'.repeat(64);
const OTHER_MACHINE = 'c'.repeat(64);
const PROJECT = '22222222-2222-4222-8222-222222222222';
const LATER = '2026-11-02T00:00:00.000Z';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

/** A fake v4.291.5 card, as `FileBoardStore.write` stores it. */
function v4Card(id: string, extra: Record<string, unknown> = {}) {
  const kind = { B: 'bug', F: 'feature', I: 'infra', C: 'chore' }[id.slice(0, 1)];
  return {
    v: 1,
    id,
    machineId: MACHINE,
    projectId: PROJECT,
    laneId: 'todo',
    kind,
    title: 'Fake card title',
    summary: 'A fake one-line summary',
    ask: { text: 'Fake owner words', source: 'fake chat' },
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
    workflow: 'quick',
    links: { prs: [], branch: null, commits: [], docs: [] },
    files: [],
    order: null,
    createdAt: AT,
    createdBy: { kind: 'ferret', sessionId: 'lead' },
    history: [{ seq: 1, at: AT, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'created', laneId: 'todo' }],
    ...extra,
  };
}

const lanes = (project: string, extra: Record<string, unknown> = {}) => ({
  projectId: project,
  version: 3,
  confirmedBy: 'owner',
  proposedBy: 'lead',
  lanes: [
    { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d' },
    { id: 'in-progress', name: 'In progress', category: 'active', enterOn: ['work.started'] },
    { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true },
  ],
  variants: { quick: ['todo', 'in-progress', 'closed'] },
  ...extra,
});

const output = async (path: string) => JSON.parse(await readFile(join(f.to, path), 'utf8')) as unknown;
const card = async (id: string) => CardSchema.parse(await output(`state/board/cards/${id}.json`));
/** A parsed v5 value, compared as plain JSON (its instants and ids are branded types). */
const plain = (value: unknown): unknown => value;
const exists = async (path: string) => (await stat(join(f.to, path)).catch(() => undefined)) !== undefined;

test('keeps the card id, the ask with its source and every mapped field; renames status to progress', async () => {
  await f.session('lead', { name: 'fake-lead' });
  const history = [
    { seq: 1, at: AT, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'created', laneId: 'todo' },
    {
      seq: 2,
      at: LATER,
      actor: { kind: 'ferret', sessionId: 'lead' },
      type: 'moved',
      from: 'todo',
      to: 'in-progress',
      backward: false,
      reason: null,
    },
  ];
  const clarifications = [
    { text: 'Fake more words', source: 'fake chat', at: AT, by: { kind: 'owner' }, byVia: 'admin-token' },
  ];
  await f.put(
    'state/board/tasks/F1792.json',
    v4Card('F1792', {
      laneId: 'in-progress',
      status: { now: 'fake now', doneSoFar: 'fake done', next: 'fake next' },
      assignee: 'helper',
      terms: [{ term: 'Fake', meaning: 'a fake term' }],
      premise: 'fake premise',
      context: 'fake context',
      brief: 'fake brief',
      howToTest: '1. fake step',
      clarifications,
      files: ['src/fake.ts'],
      order: 4,
      snoozed: { until: LATER, laneId: 'in-progress' },
      askedBy: 'person',
      visibility: 'public',
      visibilitySource: 'default',
      history,
    }),
  );
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const kept = await card('F1792');
  expect(kept).toMatchObject({
    format: 1,
    id: 'F1792',
    machineId: MACHINE,
    projectId: PROJECT,
    laneId: 'in-progress',
    kind: 'feature',
    ask: { text: 'Fake owner words', source: 'fake chat' },
    progress: { now: 'fake now', doneSoFar: 'fake done', next: 'fake next' },
    owner: 'lead',
    assignee: 'helper',
    premise: 'fake premise',
    context: 'fake context',
    brief: 'fake brief',
    howToTest: '1. fake step',
    files: ['src/fake.ts'],
    order: 4,
    snoozed: { until: LATER, laneId: 'in-progress' },
    askedBy: 'person',
    visibility: 'public',
    visibilitySource: 'default',
    createdBy: { kind: 'ferret', name: 'fake-lead', ferret: 'lead' },
    createdAt: AT,
  });
  // Every actor inside history and clarifications takes v5's CardActorSchema shape; the rest is carried whole.
  const lead = { kind: 'ferret', name: 'fake-lead', ferret: 'lead' };
  expect(plain(kept.history)).toEqual(history.map(event => ({ ...event, actor: lead })));
  expect(kept.clarifications).toEqual([
    { text: 'Fake more words', source: 'fake chat', at: AT, by: { kind: 'owner', via: 'admin-token' } },
  ]);
  expect(kept.terms).toEqual([{ term: 'Fake', meaning: 'a fake term' }]);
  const raw = (await output('state/board/cards/F1792.json')) as Record<string, unknown>;
  for (const v4Only of ['v', 'status', 'legacyRef', 'createdByVia']) expect(raw[v4Only]).toBeUndefined();
});

test('keeps parent, dependency and PR links, and the approval link to the ferret’s ask', async () => {
  const links = {
    prs: [
      {
        url: 'https://github.com/fake/repo/pull/7',
        number: 7,
        repo: 'fake/repo',
        state: 'merged',
        draft: false,
        checks: 'passing',
        mergedAt: AT,
        mergeSha: 'd'.repeat(40),
        releasedIn: null,
        polledAt: AT,
      },
    ],
    branch: 'fake/branch',
    commits: ['e'.repeat(40)],
    docs: ['https://example.invalid/fake-doc'],
  };
  const override = { by: 'owner', reason: 'fake reason', at: AT };
  await f.put('state/board/tasks/F2.json', v4Card('F2'));
  await f.put(
    'state/board/tasks/B3.json',
    v4Card('B3', {
      parent: { id: 'F2' },
      dependsOn: [
        { task: { machineId: OTHER_MACHINE, id: 'F9' }, until: 'released', override },
        { task: { id: 'F2' }, until: 'shipped' },
      ],
      links,
      blocked: { on: 'external', reason: 'fake wait', since: AT },
      approval: { sessionId: 'lead', id: 'A41' },
    }),
  );
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const kept = await card('B3');
  expect(kept.parent).toEqual({ id: 'F2' });
  expect(plain(kept.dependsOn)).toEqual([
    { task: { machineId: OTHER_MACHINE, id: 'F9' }, until: 'released', override },
    { task: { id: 'F2' }, until: 'shipped' },
  ]);
  expect(plain(kept.links)).toEqual(links);
  expect(plain(kept.blocked)).toEqual({ on: 'external', reason: 'fake wait', since: AT });
  expect(plain(kept.approval)).toEqual({ ferret: 'lead', id: 'A41' });
  expect(report.kept).toContainEqual({ what: 'card approvals linked to their ferret’s ask', count: 1 });
});

test('dropped cards and cards in a closed lane are kept', async () => {
  await f.put(
    'state/board/tasks/C1.json',
    v4Card('C1', { laneId: 'closed', dropped: { reason: 'fake superseded', at: LATER } }),
  );
  await f.put('state/board/tasks/I4.json', v4Card('I4', { laneId: 'closed' }));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(plain((await card('C1')).dropped)).toEqual({ reason: 'fake superseded', at: LATER });
  expect((await card('I4')).laneId).toBe('closed');
  expect(report.kept).toContainEqual({ what: 'cards (ids unchanged; dropped and closed cards included)', count: 2 });
  expect(report.kept).toContainEqual({ what: 'dropped cards', count: 1 });
});

test('counters continue after the highest id, whichever is higher', async () => {
  await f.put('state/board/tasks/F1792.json', v4Card('F1792'));
  await f.put('state/board/tasks/C7.json', v4Card('C7'));
  // v4 stores the LAST number handed out; F lags the files (a lost write), B is ahead of every file.
  await f.put('state/board/counters.json', { F: 1500, B: 40, C: 7 });
  expect((await boardStep.run(f.ctx())).status).toBe('converted');
  expect(CountersFileSchema.parse(await output('state/board/counters.json'))).toEqual({
    format: 1,
    next: { feature: 1793, bug: 41, chore: 8, infra: 1 },
  });
});

test('with no counter file the highest card ids still set the next numbers', async () => {
  await f.put('state/board/tasks/B12.json', v4Card('B12'));
  expect((await boardStep.run(f.ctx())).status).toBe('converted');
  expect(CountersFileSchema.parse(await output('state/board/counters.json')).next).toEqual({
    bug: 13,
    feature: 1,
    infra: 1,
    chore: 1,
  });
});

test('owner and daemon creators: via kept on the owner, the session they acted from is not', async () => {
  await f.put(
    'state/board/tasks/F1.json',
    v4Card('F1', { createdBy: { kind: 'owner', sessionId: 'lead' }, createdByVia: 'admin-token' }),
  );
  await f.put('state/board/tasks/F2.json', v4Card('F2', { createdBy: { kind: 'daemon', sessionId: 'lead' } }));
  await f.put('state/board/tasks/F3.json', v4Card('F3', { createdBy: { kind: 'ferret', sessionId: 'gone' } }));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await card('F1')).createdBy).toEqual({ kind: 'owner', via: 'admin-token' });
  expect((await card('F2')).createdBy).toEqual({ kind: 'daemon' });
  // A ferret whose session folder is gone is named by its id, and the report counts it.
  expect(plain((await card('F3')).createdBy)).toEqual({ kind: 'ferret', name: 'gone', ferret: 'gone' });
  expect(report.kept).toContainEqual({ what: 'ferret actors named by id (no v4 config left)', count: 4 });
  expect(report.notCarried.map(item => item.what).join()).not.toContain('ask.source');
  expect(plain((await card('F1')).ask)).toEqual({ text: 'Fake owner words', source: 'fake chat' });
});

test('lane sets and the switch become one board file per project', async () => {
  const unfiledLanes = lanes('unfiled', { confirmedBy: null, doneLane: 'closed', notGoodLane: 'in-progress' });
  const pending = {
    version: 4,
    baseVersion: 3,
    proposedBy: 'lead',
    proposerSession: 'lead',
    lanes: lanes(PROJECT).lanes,
    variants: {},
    doneLane: 'closed',
    notGoodLane: 'in-progress',
    relocate: {},
  };
  // A lane set from before doneLane/notGoodLane: v4 derived them on read, and so does the converter.
  await f.put(`board/lanes/${PROJECT}.json`, lanes(PROJECT, { confirmedVia: 'admin-token', pending }));
  await f.put('board/lanes/unfiled.json', unfiledLanes);
  const switchOnly = '33333333-3333-4333-8333-333333333333';
  await f.put('board/switch.json', {
    v: 1,
    migratedAt: AT,
    boards: {
      [PROJECT]: { on: true, setBy: 'owner', setAt: LATER },
      [switchOnly]: { on: true, setBy: 'migration', setAt: AT },
    },
  });
  const report = await boardStep.run(f.ctx());
  expect(report.note).toBeUndefined();
  expect(report.status).toBe('converted');
  const project = BoardFileSchema.parse(await output(`state/board/boards/${PROJECT}.json`));
  expect(plain(project.switch)).toEqual({ projectId: PROJECT, on: true, setBy: 'owner', setAt: LATER });
  expect(project.laneSet).toMatchObject({
    ...lanes(PROJECT),
    confirmedVia: 'admin-token',
    doneLane: 'closed',
    notGoodLane: 'in-progress',
    pending,
  });
  const unfiled = BoardFileSchema.parse(await output('state/board/boards/unfiled.json'));
  expect(unfiled.switch).toEqual({ projectId: 'unfiled', on: false, setBy: 'default', setAt: null });
  expect(unfiled.laneSet).toMatchObject(unfiledLanes);
  const only = BoardFileSchema.parse(await output(`state/board/boards/${switchOnly}.json`));
  expect(only).toMatchObject({ laneSet: null, switch: { on: true, setBy: 'default', setAt: AT } });
  expect(report.kept).toContainEqual({ what: 'boards (one per project)', count: 3 });
});

test('a lane file naming another project fails, naming the file only', async () => {
  await f.put(`board/lanes/${PROJECT}.json`, lanes('unfiled'));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe(`board/lanes/${PROJECT}.json names another project`);
});

test('the sweep keeps its whole memory; a damaged one is a fresh start, as in v4', async () => {
  await f.put('state/board/sweep.json', { v: 1, sweptAt: LATER, nudged: { F1: AT }, seen: { F1: { blockedBy: [] } } });
  expect((await boardStep.run(f.ctx())).status).toBe('converted');
  expect(plain(SweepFileSchema.parse(await output('state/board/sweep.json')))).toEqual({
    format: 1,
    sweptAt: LATER,
    nudged: { F1: AT },
    seen: { F1: { blockedBy: [] } },
  });
  await f.clean();
  f = await fixture();
  await f.put('state/board/sweep.json', { v: 9, fake: 'FAKE-SECRET-SWEEP' });
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await exists('state/board/sweep.json')).toBe(false);
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
});

test('dry run writes nothing', async () => {
  await f.put('state/board/tasks/F1.json', v4Card('F1'));
  await f.put('state/board/counters.json', { F: 1 });
  await f.put('board/lanes/unfiled.json', lanes('unfiled'));
  await f.put('state/board/sweep.json', { v: 1, sweptAt: AT, nudged: {}, seen: {} });
  const report = await boardStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'cards (ids unchanged; dropped and closed cards included)', count: 1 });
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('a card that does not map fails the step, names the card, never its content, and writes nothing', async () => {
  await f.put('state/board/tasks/F1.json', v4Card('F1'));
  await f.put('state/board/tasks/F2.json', v4Card('F2', { ask: { text: 'FAKE-SECRET-ASK' }, laneId: 'Bad Lane' }));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('F2');
  expect(report.note).toContain('state/board/tasks/F2.json');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
  expect(await exists('state/board/cards/F1.json')).toBe(false);
});

test('a card filed under another id, or of the wrong kind letter, fails', async () => {
  await f.put('state/board/tasks/F1.json', v4Card('F5'));
  expect((await boardStep.run(f.ctx())).note).toBe("card F1 (state/board/tasks/F1.json) holds another card's id");
  await f.clean();
  f = await fixture();
  await f.put('state/board/tasks/F1.json', { ...v4Card('F1'), kind: 'bug' });
  expect((await boardStep.run(f.ctx())).status).toBe('failed');
});

test('a top-level field v4 does not declare is named in notCarried, never valued', async () => {
  await f.put('state/board/tasks/F1.json', { ...v4Card('F1'), retiredField: 'FAKE-SECRET-VALUE' });
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.notCarried.map(item => item.what)).toContain('card fields v4.291.5 does not declare: retiredField');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
  expect(JSON.stringify(await output('state/board/cards/F1.json'))).not.toContain('FAKE-SECRET');
});

test('links in the board folders are refused, never followed', async () => {
  await f.put('state/board/tasks/F1.json', v4Card('F1'));
  await symlink('/unreadable/fake-card', join(f.from, 'state/board/tasks/F2.json'));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/board/tasks contains a link');
});

test('an empty v4 home converts to counters only, and the step is registered (no longer pending)', async () => {
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await readdir(join(f.to, 'state/board'))).toEqual(['counters.json']);
  expect(STEPS.find(step => step.id === 'board')).toBe(boardStep);
});

test('a daemon move a person reported keeps who reported it, in the v5 actor shape', async () => {
  await f.session('lead', { name: 'fake-lead' });
  const history = [
    { seq: 1, at: AT, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'created', laneId: 'todo' },
    {
      seq: 2,
      at: LATER,
      actor: { kind: 'daemon', sessionId: 'lead' },
      type: 'moved',
      from: 'todo',
      to: 'in-progress',
      backward: false,
      reason: null,
      auto: true,
      trigger: 'pr.review_approved',
      reportedBy: { kind: 'owner' },
      reportedVia: 'admin-token',
    },
  ];
  await f.put('state/board/tasks/F1.json', v4Card('F1', { history }));
  expect((await boardStep.run(f.ctx())).status).toBe('converted');
  const moved = (await card('F1')).history[1] as Record<string, unknown>;
  expect(moved.actor).toEqual({ kind: 'daemon' });
  expect(moved.reportedBy).toEqual({ kind: 'owner', via: 'admin-token' });
  expect(moved).not.toHaveProperty('reportedVia');
  expect(moved).not.toHaveProperty('actorVia');
});

test('a history event with an unreadable actor fails the step, naming the card only', async () => {
  const history = [
    { seq: 1, at: AT, actor: { kind: 'robot', sessionId: 'SECRET-FAKE' }, type: 'created', laneId: 'todo' },
  ];
  await f.put('state/board/tasks/F1.json', v4Card('F1', { history }));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(JSON.stringify(report)).not.toContain('SECRET-FAKE');
  expect(await exists('state/board/cards/F1.json')).toBe(false);
});

test('a ferret actor is named by its v4 callsign, else a valid title, else its id', async () => {
  await f.session('lead', { name: 'Fake title: not a name!', teammate: 'arleen' });
  await f.session('helper', { name: 'Fake title: not a name!' });
  const history = [
    { seq: 1, at: AT, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'created', laneId: 'todo' },
    { seq: 2, at: LATER, actor: { kind: 'ferret', sessionId: 'helper' }, type: 'note', text: 'fake note' },
  ];
  await f.put('state/board/tasks/F1.json', v4Card('F1', { history }));
  expect((await boardStep.run(f.ctx())).status).toBe('converted');
  const kept = await card('F1');
  expect(plain(kept.createdBy)).toEqual({ kind: 'ferret', name: 'arleen', ferret: 'lead' });
  expect(plain(kept.history[1]?.actor)).toEqual({ kind: 'ferret', name: 'helper', ferret: 'helper' });
});

test('every v4 history event type maps: migrated becomes a note, a status edit a progress edit', async () => {
  const lead = { kind: 'ferret', sessionId: 'lead' };
  const owner = { kind: 'owner', sessionId: 'lead' };
  const history = [
    { seq: 1, at: AT, actor: lead, type: 'created', laneId: 'todo' },
    { seq: 2, at: AT, actor: lead, type: 'migrated', legacyRef: 'lead:F3' },
    { seq: 3, at: AT, actor: lead, type: 'field-edited', field: 'status' },
    { seq: 4, at: AT, actor: lead, type: 'moved', from: 'todo', to: 'in-progress', backward: false, reason: null },
    {
      seq: 5,
      at: AT,
      actor: owner,
      actorVia: 'admin-token',
      type: 'reopened',
      from: 'in-progress',
      to: 'todo',
      reason: 'fake reason',
      ask: { text: 'fake words', source: 'fake chat' },
    },
    { seq: 6, at: AT, actor: lead, type: 'note', text: 'fake note' },
    { seq: 7, at: AT, actor: owner, type: 'clarified', text: 'fake more', source: 'fake chat' },
    { seq: 8, at: AT, actor: lead, type: 'linked', field: 'branch', value: 'fake/branch' },
    { seq: 9, at: AT, actor: lead, type: 'assigned', from: null, to: 'helper', handedDown: true },
    { seq: 10, at: AT, actor: lead, type: 'depended', task: { id: 'F2' }, until: 'shipped' },
    { seq: 11, at: AT, actor: lead, type: 'undepended', task: { id: 'F2' }, reason: 'fake reason' },
    { seq: 12, at: AT, actor: lead, type: 'blocked', reason: 'fake wait' },
    { seq: 13, at: AT, actor: lead, type: 'unblocked', reason: null },
    { seq: 14, at: AT, actor: lead, type: 'file-claimed', path: 'src/fake.ts' },
    { seq: 15, at: AT, actor: lead, type: 'file-released', path: 'src/fake.ts', reason: null },
    { seq: 16, at: AT, actor: owner, type: 'ordered', from: null, to: 2 },
    { seq: 17, at: AT, actor: owner, type: 'snoozed', until: null },
    {
      seq: 18,
      at: AT,
      actor: owner,
      type: 'refiled',
      fromProject: 'unfiled',
      toProject: PROJECT,
      toLane: 'todo',
      reason: null,
    },
    { seq: 19, at: AT, actor: lead, type: 'reparented', from: null, to: { id: 'F2' }, reason: null },
    { seq: 20, at: AT, actor: { kind: 'daemon' }, type: 'dropped', reason: 'fake superseded' },
  ];
  await f.put('state/board/tasks/F1.json', v4Card('F1', { history, legacyRef: 'lead:F3' }));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const kept = await card('F1');
  expect(plain(kept.history.map(event => event.type))).toEqual([
    'created',
    'note',
    'field-edited',
    ...history.slice(3).map(event => event.type),
  ]);
  expect(plain(kept.history[1])).toEqual({
    seq: 2,
    at: AT,
    actor: { kind: 'ferret', name: 'lead', ferret: 'lead' },
    type: 'note',
    text: 'migrated from the v4 task list as lead:F3',
  });
  expect(plain(kept.history[2])).toMatchObject({ type: 'field-edited', field: 'progress' });
  expect(plain(kept.history[4]?.actor)).toEqual({ kind: 'owner', via: 'admin-token' });
  expect(report.kept).toContainEqual({
    what: 'v4 `migrated` history events kept as notes naming the legacy ref',
    count: 1,
  });
});

test('a history event type v4 does not have fails the step, naming the card and the type', async () => {
  const history = [
    { seq: 1, at: AT, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'created', laneId: 'todo' },
    { seq: 2, at: AT, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'teleported', where: 'FAKE-SECRET-PLACE' },
  ];
  await f.put('state/board/tasks/F1.json', v4Card('F1', { history }));
  await f.put('state/board/tasks/F2.json', v4Card('F2'));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe("card F1 has a history event of a type v4 does not have: 'teleported'");
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
  expect(await exists('state/board/cards/F2.json')).toBe(false);
});

test('a history event or clarification field v4 does not declare is named in notCarried, never valued', async () => {
  const history = [
    {
      seq: 1,
      at: AT,
      actor: { kind: 'ferret', sessionId: 'lead' },
      type: 'created',
      laneId: 'todo',
      retiredEventField: 'FAKE-SECRET-EVENT',
    },
  ];
  const clarifications = [
    { text: 'fake more', source: 'fake chat', at: AT, by: { kind: 'owner' }, byName: 'FAKE-SECRET-NAME' },
  ];
  await f.put('state/board/tasks/F1.json', v4Card('F1', { history, clarifications }));
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const whats = report.notCarried.map(item => item.what);
  expect(whats).toContain('history event fields v4.291.5 does not declare: retiredEventField');
  expect(whats).toContain('clarification fields v4.291.5 does not declare: byName');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
  expect(JSON.stringify(await output('state/board/cards/F1.json'))).not.toContain('FAKE-SECRET');
});

test('a gate that reopens with an agenda conversation reopens with an ask in v5', async () => {
  const verify = {
    id: 'to-test',
    name: 'To test',
    category: 'verify',
    stage: {
      kind: 'gate',
      options: [
        { id: 'done', label: 'Done', outcome: { kind: 'close' } },
        { id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-agenda' } },
      ],
    },
  };
  const base = lanes(PROJECT);
  const withVerify = [...base.lanes.slice(0, 2), verify, base.lanes[2]];
  await f.put(
    `board/lanes/${PROJECT}.json`,
    lanes(PROJECT, { lanes: withVerify, variants: { quick: ['todo', 'in-progress', 'to-test', 'closed'] } }),
  );
  expect((await boardStep.run(f.ctx())).status).toBe('converted');
  const board = BoardFileSchema.parse(await output(`state/board/boards/${PROJECT}.json`));
  const gate = board.laneSet?.lanes.find(lane => lane.id === 'to-test')?.stage;
  expect(plain(gate)).toEqual({
    kind: 'gate',
    options: [
      { id: 'done', label: 'Done', outcome: { kind: 'close' } },
      { id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-ask' } },
    ],
  });
});

test('each ferret’s focus, anchor and skip move from its session config to the board’s focus file', async () => {
  await f.session('lead', { focusTask: { id: 'F1' }, focusAnchor: { machineId: OTHER_MACHINE, id: 'F9' } });
  await f.session('helper', { boardSkip: { reason: 'fake chit-chat', at: AT } });
  await f.session('idle');
  const report = await boardStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(plain(FocusFileSchema.parse(await output('state/board/focus.json')))).toEqual({
    format: 1,
    ferrets: {
      lead: { card: { id: 'F1' }, anchor: { machineId: OTHER_MACHINE, id: 'F9' }, skip: null },
      helper: { card: null, anchor: null, skip: { reason: 'fake chit-chat', at: AT } },
    },
  });
  expect(report.kept).toContainEqual({ what: 'ferrets with a board focus, anchor or skip', count: 2 });
});
