import { describe, it } from 'bun:test';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import should from 'should';
import { archivedOf, askRows, ASK_ROUTES, ferretsOf, waitingOn } from '../../src/lib/commands/ask.ts';
import { runFy } from '../../src/lib/run.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { fakeWorld, inventoryOf, RecordingTransport, registryOf, skeletonEntry } from './fakes.ts';

const open = { minimum: 'operator', caller: 'any', audit: { skip: 'test' }, guard: { none: 'ids' } } as const;
const declare = (id: string, title: string, ...keys: string[]) =>
  definePlugin({
    id,
    title,
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    actions: { routes: keys.map(key => route(key, open)) },
  });
/** The routes Ferrets and Asks really declare for this verb (core/ferrets, core/asks manifests). */
const ferretsManifest = declare('ferrets', 'Ferrets', ASK_ROUTES.ferrets, ASK_ROUTES.archived);
const asksManifest = declare('asks', 'Asks', ASK_ROUTES.board, ASK_ROUTES.item, ASK_ROUTES.answer);
const inventory = () => inventoryOf({ id: 'asks', contract: 'h-asks' }, { id: 'ferrets', contract: 'h-ferrets' });
const registry = () => registryOf(skeletonEntry(asksManifest, 'h-asks'), skeletonEntry(ferretsManifest, 'h-ferrets'));

/** A daemon answering by method and path, so the order boards are read in does not matter. */
class RoutedTransport extends RecordingTransport {
  constructor(private readonly answers: Record<string, DaemonReply | Error>) {
    super();
  }
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    const answer = this.answers[`${request.method} ${request.path}`];
    if (answer instanceof Error) throw answer;
    return answer ?? { status: 404, body: { error: 'nothing here' } };
  }
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `subject of ${id}`,
  waitingSince: `2026-11-1${id.slice(1)}T00:00:00.000Z`,
  ...extra,
});
const board = (...items: unknown[]) => ({ status: 200, body: { v: 1, items, resolved: [], count: items.length } });

const FERRETS = {
  status: 200,
  body: [
    { id: 'f1', name: 'alpha' },
    { id: 'f2', name: 'beta' },
  ],
};

const ARCHIVED = '/v1/archived-sessions?limit=500';
/** Nothing archived, unless a test says otherwise. */
const NONE_ARCHIVED = { status: 200, body: { count: 0, sessions: [] } };
const archivedView = (id: string, name = id) => ({ config: { id, name }, state: 'stopped', directory: '/x' });

const world = (answers: Record<string, DaemonReply | Error>, environment: Record<string, string> = {}) => {
  const transport = new RoutedTransport({ [`GET ${ARCHIVED}`]: NONE_ARCHIVED, ...answers });
  return { ...fakeWorld({ registry: registry(), inventory: inventory(), transport, environment }), transport };
};

describe('fy ask', () => {
  it('should say Asks is not built yet while the routes it needs are not declared', async () => {
    const { world: bare, io } = fakeWorld();
    should(await runFy(['ask'], bare)).equal(69);
    should(io.stderr()).containEql('Asks is not built yet');
  });

  it('should list the asks waiting on the owner across every ferret, oldest first', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': board(
        item('A3', { title: 'Move c1?', kind: 'yesno' }),
        item('A4', { notice: true }),
        item('A5', { waitingOn: 'ferret' }),
        item('A6', { parked: { reason: 'snoozed' } }),
      ),
      'GET /v1/ferrets/f2/agenda': board(item('A1', { ask: { kind: 'open-question' } })),
    });
    should(await runFy(['ask'], w)).equal(0);
    const lines = io.stdout().trimEnd().split('\n');
    should(lines).have.length(3);
    should(lines[0]).match(/^ASK\s+FERRET\s+KIND\s+ASKING$/u);
    should(lines[1]).match(/^f2\/A1\s+beta\s+open-question\s+subject of A1$/u);
    should(lines[2]).match(/^f1\/A3\s+alpha\s+yesno\s+Move c1\?$/u);
    should(transport.sent.map(request => request.path).sort()).deepEqual([
      '/v1/archived-sessions?limit=500',
      '/v1/ferrets',
      '/v1/ferrets/f1/agenda',
      '/v1/ferrets/f2/agenda',
    ]);
  });

  it('should say none are waiting when there are no ferrets and when every board is quiet', async () => {
    const none = world({ 'GET /v1/ferrets': { status: 200, body: [] } });
    should(await runFy(['ask', 'list'], none.world)).equal(0);
    should(none.io.stdout()).equal('no asks are waiting\n');
    const quiet = world({
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': board(),
      'GET /v1/ferrets/f2/agenda': board(),
    });
    should(await runFy(['ask'], quiet.world)).equal(0);
    should(quiet.io.stdout()).equal('no asks are waiting\n');
  });

  it('should list what it can read, name a board it could not, and exit 1', async () => {
    const { world: w, io } = world({
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': { status: 403, body: { error: 'not yours' } },
      'GET /v1/ferrets/f2/agenda': board(item('A1')),
    });
    should(await runFy(['ask'], w)).equal(1);
    should(io.stdout()).containEql('f2/A1');
    should(io.stderr()).containEql('could not read the asks of f1: not yours');
  });

  it('should show one ask by ferret and id with one read, and find a bare id on its own ferret', async () => {
    const one = world({ 'GET /v1/ferrets/f1/agenda/A3': { status: 200, body: { id: 'A3', subject: 's' } } });
    should(await runFy(['ask', 'show', 'f1/A3'], one.world)).equal(0);
    should(JSON.parse(one.io.stdout())).deepEqual({ id: 'A3', subject: 's' });
    should(one.transport.sent).have.length(1);
    const bare = world({
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': board(),
      'GET /v1/ferrets/f2/agenda': board(item('A3')),
      'GET /v1/ferrets/f2/agenda/A3': { status: 200, body: { id: 'A3' } },
    });
    should(await runFy(['ask', 'show', 'A3'], bare.world)).equal(0);
    should(bare.transport.sent.at(-1)?.path).equal('/v1/ferrets/f2/agenda/A3');
  });

  it('should refuse a bare id that is on two ferrets, naming both, and one that is on none', async () => {
    const answers = {
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': board(item('A1')),
      'GET /v1/ferrets/f2/agenda': board(item('A1')),
    };
    const two = world(answers);
    should(await runFy(['ask', 'show', 'A1'], two.world)).equal(2);
    should(two.io.stderr()).containEql('f1/A1 or f2/A1');
    const none = world(answers);
    should(await runFy(['ask', 'show', 'A9'], none.world)).equal(1);
    should(none.io.stderr()).containEql('no ask A9 is waiting');
  });

  it('should answer an ask with words as an open question, on its own ferret', async () => {
    const { world: w, io, transport } = world({ 'POST /v1/ferrets/f1/agenda': { status: 200, body: {} } });
    should(await runFy(['ask', 'answer', 'f1/A3', 'yes', 'please'], w)).equal(0);
    should(transport.sent).deepEqual([
      {
        method: 'POST',
        path: '/v1/ferrets/f1/agenda',
        body: { action: 'resolve', id: 'A3', response: { kind: 'open-question', answer: 'yes please' } },
      },
    ]);
    should(io.stdout()).equal('answered f1/A3\n');
  });

  it('should carry every v4 answer flag, and refuse two at once or none', async () => {
    const cases: [string[], unknown][] = [
      [['--approve'], { kind: 'permission', decision: 'approve' }],
      [['--reject'], { kind: 'permission', decision: 'reject' }],
      [['--yes'], { kind: 'multiple-choice', choice: 'Yes' }],
      [['--no'], { kind: 'multiple-choice', choice: 'No' }],
      [['--choice', 'Blue'], { kind: 'multiple-choice', choice: 'Blue' }],
      [['--good'], { kind: 'answer-review', verdict: 'good' }],
      [['--clarify', 'why'], { kind: 'answer-review', verdict: 'clarify', clarification: 'why' }],
      [['--other', 'none'], { kind: 'other', answer: 'none' }],
      [['--text', 'hello'], { kind: 'open-question', answer: 'hello' }],
    ];
    for (const [flags, response] of cases) {
      const { world: w, transport } = world({ 'POST /v1/ferrets/f1/agenda': { status: 200, body: {} } });
      should(await runFy(['ask', 'answer', 'f1/A3', ...flags], w)).equal(0);
      should((transport.sent[0]?.body as { response?: unknown } | undefined)?.response).deepEqual(response);
    }
    const done = world({ 'POST /v1/ferrets/f1/agenda': { status: 200, body: {} } });
    should(await runFy(['ask', 'answer', 'f1/A3', '--done'], done.world)).equal(0);
    should(done.transport.sent[0]?.body).deepEqual({ action: 'resolve', id: 'A3' });
    const clash = world({});
    should(await runFy(['ask', 'answer', 'f1/A3', '--approve', '--yes'], clash.world)).equal(2);
    should(clash.io.stderr()).containEql('give exactly one answer');
    should(await runFy(['ask', 'answer', 'f1/A3'], clash.world)).equal(2);
    should(clash.transport.sent).deepEqual([]);
  });

  it('should print the daemon refusal and exit 1 when the answer is refused', async () => {
    const { world: w, io } = world({
      'POST /v1/ferrets/f1/agenda': { status: 409, body: { error: 'the ask changed' } },
    });
    should(await runFy(['ask', 'answer', 'f1/A3', 'x'], w)).equal(1);
    should(io.stderr()).containEql('the ask changed');
  });

  it('lets a ferret’s pane answer an ordinary ask on its own board: the daemon decides, the CLI does not refuse first', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({ 'POST /v1/ferrets/s1/agenda': { status: 200, body: {} } }, { FY_SESSION_ID: 's1' });
    should(await runFy(['ask', 'answer', 's1/A3', 'main'], w)).equal(0);
    should(transport.sent.map(request => `${request.method} ${request.path}`)).deepEqual([
      'POST /v1/ferrets/s1/agenda',
    ]);
    should(io.stdout()).equal('answered s1/A3\n');
  });

  it('prints the daemon’s own refusal when a pane answers on another ferret’s board or an owner-only ask', async () => {
    const crossBoard = 'a ferret may only answer an ask on its own board';
    const ownerOnly = 'this ask is the owner’s to answer';
    for (const [ref, sentence] of [
      ['f1/A3', crossBoard],
      ['s1/A4', ownerOnly],
    ] as const) {
      const { world: w, io } = world(
        { [`POST /v1/ferrets/${ref.split('/')[0]}/agenda`]: { status: 403, body: { error: sentence } } },
        { FY_SESSION_ID: 's1' },
      );
      should(await runFy(['ask', 'answer', ref, 'x'], w)).equal(1);
      should(io.stderr()).containEql(sentence);
      should(io.stderr()).not.containEql("this is the owner's command");
    }
  });

  it('should let a ferret’s pane read, as the routes it reads allow', async () => {
    const { world: w, connects } = world({ 'GET /v1/ferrets': { status: 200, body: [] } }, { FY_SESSION_ID: 's1' });
    should(await runFy(['ask', 'list'], w)).equal(0);
    should(connects).have.length(1);
  });

  it('should refuse a missing id, a missing answer and an unknown subcommand', async () => {
    const { world: w } = world({});
    should(await runFy(['ask', 'show'], w)).equal(2);
    should(await runFy(['ask', 'answer'], w)).equal(2);
    should(await runFy(['ask', 'zap'], w)).equal(2);
  });

  it('lists a waiting ask on an archived, stopped ferret the live list leaves out, as the app shows it', async () => {
    const { world: w, io } = world({
      'GET /v1/ferrets': { status: 200, body: [] },
      [`GET ${ARCHIVED}`]: { status: 200, body: { count: 1, sessions: [archivedView('archived', 'old one')] } },
      'GET /v1/ferrets/archived/agenda': board(item('A1', { title: 'Still waiting' })),
    });
    should(await runFy(['ask'], w)).equal(0);
    should(io.stdout()).match(/archived\/A1\s+old one/u);
  });

  it('names the archived ferrets it could not read and still prints the live ones, exit 1', async () => {
    const { world: w, io } = world({
      'GET /v1/ferrets': FERRETS,
      [`GET ${ARCHIVED}`]: { status: 500, body: { error: 'archive unavailable' } },
      'GET /v1/ferrets/f1/agenda': board(item('A1')),
      'GET /v1/ferrets/f2/agenda': board(),
    });
    should(await runFy(['ask'], w)).equal(1);
    should(io.stdout()).containEql('f1/A1');
    should(io.stderr()).containEql('the archived ferrets: archive unavailable');
  });

  it('says so when more ferrets are archived than one read returns', async () => {
    const { world: w, io } = world({
      'GET /v1/ferrets': { status: 200, body: [] },
      [`GET ${ARCHIVED}`]: { status: 200, body: { count: 502, sessions: [archivedView('a1')] } },
      'GET /v1/ferrets/a1/agenda': board(item('A1')),
    });
    should(await runFy(['ask'], w)).equal(1);
    should(io.stdout()).containEql('a1/A1');
    should(io.stderr()).containEql('501 older archived ferrets');
  });

  it('refuses a bare id when a board could not be read, names it, and answers nothing', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': { status: 500, body: { error: 'ledger unavailable' } },
      'GET /v1/ferrets/f2/agenda': board(item('A1')),
      'POST /v1/ferrets/f2/agenda': { status: 200, body: {} },
    });
    should(await runFy(['ask', 'answer', 'A1', 'main'], w)).equal(1);
    should(io.stderr()).containEql('f1: ledger unavailable');
    should(io.stderr()).containEql('<ferret>/A1');
    should(transport.sent.some(request => request.method === 'POST')).equal(false);
  });

  it('refuses a bare id for show too when the only board that could match is unreadable', async () => {
    const { world: w, io } = world({
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': { status: 500, body: { error: 'ledger unavailable' } },
      'GET /v1/ferrets/f2/agenda': board(),
    });
    should(await runFy(['ask', 'show', 'A1'], w)).equal(1);
    should(io.stderr()).containEql('f1: ledger unavailable');
    should(io.stderr()).not.containEql('no ask A1 is waiting');
  });

  it('treats a timed-out board and a malformed board like a refusal: names it, prints the rest, exit 1', async () => {
    for (const failure of [new Error('board read timed out'), { status: 200, body: { unreadable: true } }]) {
      const { world: w, io } = world({
        'GET /v1/ferrets': FERRETS,
        'GET /v1/ferrets/f1/agenda': failure,
        'GET /v1/ferrets/f2/agenda': board(item('A1')),
      });
      should(await runFy(['ask'], w)).equal(1);
      should(io.stdout()).containEql('f2/A1');
      should(io.stderr()).containEql('could not read the asks of f1:');
    }
    const timeout = world({
      'GET /v1/ferrets': FERRETS,
      'GET /v1/ferrets/f1/agenda': new Error('board read timed out'),
      'GET /v1/ferrets/f2/agenda': board(),
    });
    await runFy(['ask'], timeout.world);
    should(timeout.io.stderr()).containEql('board read timed out');
  });

  it('should read a shape it does not know as an error, not a crash', () => {
    should(() => ferretsOf({ nope: true })).throw(/shape this fy does not read/u);
    should(() => ferretsOf([{ name: 'x' }])).throw(/shape this fy does not read/u);
    should(() => waitingOn({ id: 'f1', name: 'a' }, { nope: true })).throw(/shape this fy does not read/u);
    should(() => archivedOf({ count: 1 })).throw(/shape this fy does not read/u);
    should(() => archivedOf({ count: 1, sessions: [{ nope: 1 }] })).throw(/shape this fy does not read/u);
    should(askRows([])).deepEqual([]);
  });
});
