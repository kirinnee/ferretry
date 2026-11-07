import { describe, it } from 'bun:test';
import should from 'should';
import {
  AT,
  card,
  cardResponse,
  DENISHA,
  FERRETRY_ID,
  laneSet,
  listing,
  project,
  response,
} from '../../unit/cli/fixtures.ts';
import { run } from './harness.ts';

const PROJECTS = listing({ projects: [project()], current: FERRETRY_ID as never });
const STANDARD = {
  'GET /v1/board/projects': PROJECTS,
  'GET /v1/ferrets': [{ id: DENISHA, name: 'denisha' }],
};
const CARD = cardResponse(card({ id: 'F7' }), laneSet());
const body = (result: { calls: readonly { route: string; init?: unknown }[] }, index = 0) =>
  (result.calls[index]?.init as { body?: unknown } | undefined)?.body;
/** The body of the one write a verb sent (a POST), wherever the reads fall around it. */
const written = (result: { calls: readonly { route: string; init?: unknown }[] }) =>
  body({ calls: result.calls.filter(call => call.route.startsWith('POST ')) });

describe('fy board', () => {
  it('should read the board of the calling ferret’s project and draw it lane by lane', async () => {
    const result = await run('board', {
      answers: { ...STANDARD, 'GET /v1/board': response({ cards: [card({ id: 'F7', title: 'Rename the widget' })] }) },
    });
    should(result.code).equal(0);
    should(result.calls.map(call => call.route)).eql(['GET /v1/board/projects', 'GET /v1/ferrets', 'GET /v1/board']);
    should(result.out)
      .match(/Ferretry/u)
      .and.match(/&F7/u)
      .and.match(/Rename the widget/u);
  });

  it('should print the daemon’s answer with --json', async () => {
    const result = await run('board', {
      options: { json: true },
      answers: { ...STANDARD, 'GET /v1/board': response() },
    });
    should(JSON.parse(result.out)).have.property('cards');
  });

  it('should refuse --mine outside a ferret, and say so on stderr with exit 1', async () => {
    const result = await run('board', { options: { mine: true }, answers: STANDARD });
    should(result.code).equal(1);
    should(result.err).match(/--mine needs a ferret/u);
  });

  it('should filter --mine on FY_SESSION_ID from the shell’s environment', async () => {
    const result = await run('board', {
      options: { mine: true },
      env: { FY_SESSION_ID: DENISHA },
      answers: { ...STANDARD, 'GET /v1/board': response() },
    });
    should(result.code).equal(0);
    const board = result.calls.find(call => call.route === 'GET /v1/board');
    should(((board?.init ?? {}) as { query: Record<string, string> }).query).have.property('ferret', DENISHA);
  });
});

describe('fy card new', () => {
  const options = { kind: 'feature', ask: 'rename it', 'ask-source': 'chat://1' };

  it('should check for related work, then create the card and say where it stands', async () => {
    const result = await run('card new', {
      args: ['Rename', 'widget'],
      options,
      answers: { ...STANDARD, 'POST /v1/search/related': { matches: [] }, 'POST /v1/board/cards': CARD },
    });
    should(result.code).equal(0);
    should(result.calls.map(call => call.route)).containEql('POST /v1/search/related');
    should(result.calls.map(call => call.route)).containEql('POST /v1/board/cards');
    should(written(result)).have.property('title', 'Rename widget');
    should(result.out).match(/&F7/u);
  });

  it('should refuse a strong duplicate with exit 1 and create nothing', async () => {
    const result = await run('card new', {
      args: ['Rename', 'widget'],
      options,
      answers: {
        ...STANDARD,
        'POST /v1/search/related': {
          matches: [
            {
              strength: 'strong',
              hit: {
                kind: 'card',
                id: 'F9',
                title: 'Rename widget',
                standing: 'In progress',
                match: { field: 'title', line: 'Rename widget' },
                ferret: null,
              },
            },
          ],
        },
        'POST /v1/board/cards': CARD,
      },
    });
    should(result.code).equal(1);
    should(result.err).match(/Related work already exists/u);
    should(result.calls.map(call => call.route)).not.containEql('POST /v1/board/cards');
  });

  it('should let the shell print why --brief-file cannot be read', async () => {
    const failure = await run('card new', {
      args: ['Rename', 'widget'],
      options: { ...options, 'brief-file': '/nope.md' },
      answers: { ...STANDARD, 'POST /v1/search/related': { matches: [] }, 'POST /v1/board/cards': CARD },
      files: {},
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    should((failure as Error).message).match(/no such file/u);
  });
});

describe('fy card show, move and progress', () => {
  it('should show one card in full', async () => {
    const result = await run('card show', {
      args: ['&F7'],
      answers: { ...STANDARD, 'GET /v1/board/cards/:cardId': CARD },
    });
    should(result.code).equal(0);
    should(result.out).match(/F7/u);
    should(result.calls[0]).eql({ route: 'GET /v1/board/cards/:cardId', init: { params: { cardId: 'F7' } } });
  });

  it('should print the card as the patch document with --yaml', async () => {
    const result = await run('card show', {
      args: ['F7'],
      options: { yaml: true },
      answers: { ...STANDARD, 'GET /v1/board/cards/:cardId': CARD },
    });
    should(result.out)
      .match(/revision:/u)
      .and.match(/card patch F7 --file/u);
  });

  it('should move a card to a lane by name', async () => {
    const result = await run('card move', {
      args: ['F7', 'Implement'],
      options: { reason: 'started' },
      answers: { ...STANDARD, 'GET /v1/board/cards/:cardId': CARD, 'POST /v1/board/cards/:cardId': CARD },
    });
    should(result.code).equal(0);
    should(written(result)).containEql({ action: 'move', to: 'implement' });
  });

  it('should write the progress as ONE edit with only the parts named (card progress replaces the status writer)', async () => {
    const result = await run('card progress', {
      args: ['F7'],
      options: { now: 'testing', next: '1. ship' },
      answers: { 'POST /v1/board/cards/:cardId': CARD, ...STANDARD },
    });
    should(result.code).equal(0);
    should(result.calls[0]).eql({
      route: 'POST /v1/board/cards/:cardId',
      init: { params: { cardId: 'F7' }, body: { action: 'edit', progress: { now: 'testing', next: '1. ship' } } },
    });
  });

  it('should read the whole progress from --file', async () => {
    const result = await run('card progress', {
      args: ['F7'],
      options: { file: '/p.yaml' },
      files: { '/p.yaml': 'now: from file\nnext: later\n' },
      answers: { 'POST /v1/board/cards/:cardId': CARD, ...STANDARD },
    });
    should(body(result)).eql({ action: 'edit', progress: { now: 'from file', doneSoFar: '', next: 'later' } });
  });

  it('should refuse a progress write that names nothing', async () => {
    const result = await run('card progress', { args: ['F7'], answers: STANDARD });
    should(result.code).equal(1);
    should(result.err).match(/nothing to write/u);
    should(result.calls).eql([]);
  });
});

describe('the other card verbs', () => {
  const answers = { ...STANDARD, 'POST /v1/board/cards/:cardId': CARD, 'GET /v1/board/cards/:cardId': CARD };

  it('should send each verb as the one action it is', async () => {
    const cases: [string, string[], Record<string, string | boolean>, object][] = [
      ['card focus', ['F7'], {}, { action: 'focus' }],
      ['card block', ['F7', 'waiting', 'on', 'infra'], {}, { action: 'block', reason: 'waiting on infra' }],
      ['card unblock', ['F7'], { reason: 'done' }, { action: 'unblock', reason: 'done' }],
      ['card claim', ['F7'], {}, { action: 'claim' }],
      ['card note', ['F7', 'hello', 'there'], {}, { action: 'note', text: 'hello there' }],
      ['card drop', ['F7'], { reason: 'moot' }, { action: 'drop', reason: 'moot' }],
    ];
    for (const [verb, args, options, expected] of cases) {
      const result = await run(verb, { args, options, answers });
      should(result.code).equal(0, `${verb}: ${result.err}`);
      should(written(result)).containEql(expected);
    }
  });

  it('should record a skip', async () => {
    const result = await run('card skip', {
      args: ['no', 'card', 'needed'],
      answers: { 'POST /v1/board/skip': { ferret: DENISHA, skip: { reason: 'no card needed', at: AT } } },
    });
    should(result.code).equal(0);
    should(body(result)).eql({ reason: 'no card needed' });
  });

  it('should patch a card from a document, sending one edit with the revision', async () => {
    const result = await run('card patch', {
      args: ['F7'],
      options: { file: '/f7.yaml' },
      files: { '/f7.yaml': 'revision: 1\ntitle: Renamed widget\n' },
      answers,
    });
    should(result.code).equal(0, result.err);
    should(written(result)).containEql({ action: 'edit', revision: 1, title: 'Renamed widget' });
  });

  it('should not implement an answer verb, a board import or a task alias: a card never asks', () => {
    return Promise.all(
      ['card answer', 'card ask', 'board import', 'task create', 'card create', 'card status'].map(async verb => {
        let failure: unknown;
        try {
          await run(verb, { answers });
        } catch (error) {
          failure = error;
        }
        should(failure).be.an.Error();
        should((failure as Error).message).match(/does not implement/u);
      }),
    );
  });
});

describe('fy card merge-gate', () => {
  const PR = 'https://github.com/kirinnee/ferretry/pull/42';
  const gate = (overrides: object) => ({
    'GET /v1/board/merge-gate': { pr: PR, unit: [], waits: [], unreadable: [], ...overrides },
  });

  it('should exit 0 and print nothing when the PR waits on nothing', async () => {
    const result = await run('card merge-gate', { args: [PR], answers: gate({}) });
    should(result.code).equal(0);
    should(result.out).equal('');
    should(result.calls[0]).eql({ route: 'GET /v1/board/merge-gate', init: { query: { pr: PR } } });
  });

  it('should exit 1 with the waits', async () => {
    const result = await run('card merge-gate', {
      args: [PR],
      answers: gate({ waits: [{ card: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' }] }),
    });
    should(result.code).equal(1);
    should(result.out).match(/&F20 waits on &F18/u);
  });

  it('should exit 2 when the daemon cannot answer, so the merger fails closed', async () => {
    const result = await run('card merge-gate', { args: [PR], answers: {} });
    should(result.code).equal(2);
    should(result.err).match(/no answer/u);
  });
});

describe('fy board lanes, workflow and status', () => {
  const lanes = { ...STANDARD, 'GET /v1/board/projects/:projectId/lanes': project() };

  it('should show the project’s lanes', async () => {
    const result = await run('board lanes show', { answers: lanes });
    should(result.code).equal(0);
    should(result.out).match(/Ferretry lanes, version 3/u);
  });

  it('should propose a lane set and say the owner is asked', async () => {
    const result = await run('board lanes propose', {
      options: { template: 'pr' },
      answers: {
        ...lanes,
        'POST /v1/board/projects/:projectId/lanes': { laneSet: laneSet({ version: 4 }), ask: 'raised' },
      },
    });
    should(result.code).equal(0);
    should(result.out).match(/Accept \/ Edit choice/u);
  });

  it('should show the workflow', async () => {
    const result = await run('board workflow show', { answers: lanes });
    should(result.code).equal(0);
    should(result.out).match(/workflow/u);
  });

  it('should say whether the board is on, and who set it', async () => {
    const result = await run('board status', {
      answers: {
        ...lanes,
        'GET /v1/board/projects/:projectId/switch': { projectId: FERRETRY_ID, on: true, setBy: 'owner', setAt: AT },
      },
    });
    should(result.out).match(/board on — set by the owner/u);
  });
});
