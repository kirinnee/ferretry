import { afterAll, beforeAll, describe, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type AgendaGate,
  type AgendaItem,
  agendaState,
  BoardTaskCreateRequestSchema,
  DAEMON_FEATURES,
  gateReference,
  needsYouQueue,
  restingQueue,
} from '@ferretry/protocol';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../daemon/src/adapters/agenda/file-agenda-ledger-repository.ts';
import {
  FileAgendaSeenStore,
  FileAgendaVersionStore,
} from '../../../daemon/src/adapters/agenda/file-agenda-versions.ts';
import { inlineAgendaVersionsWorker } from '../../../daemon/tests/support/agenda-versions-worker.ts';
import { AgendaRestNudger } from '../../../daemon/src/lib/agenda/rest-nudge.ts';
import {
  type AgendaActor,
  type AgendaMutation,
  AgendaService,
  type OwnerChat,
  type RaiseAgendaRequest,
} from '../../../daemon/src/lib/agenda/index.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../daemon/src/lib/api/capability.ts';
import { ApiDispatcher, ApiRouter } from '../../../daemon/src/lib/api/index.ts';
import { BoardError, BoardService, cardVisibility } from '../../../daemon/src/lib/board/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../daemon/src/lib/grants/index.ts';
import { agendaRoutes } from '../../../daemon/src/lib/runtime/index.ts';
import { card, MemoryBoardStore, world as boardWorld } from '../../../daemon/tests/unit/board/support.ts';
import { DIRECTORY, REFUSED } from '../../../daemon/tests/unit/sub-ferret/support.ts';
import { request as apiRequest } from '../../../daemon/tests/unit/api/support.ts';
import { health } from '../unit/daemon/fixtures';
import { BinaryCliDriver, type CliDriver, InProcessCliDriver } from './driver';

/**
 * THE DEFINITION OF DONE, ITEM BY ITEM (docs/agenda.md § Definition of done). Each test is named `DoD <n>: <spec words>`
 * so the checklist reads straight from the test output.
 *
 * WHAT THIS PROVES: the agenda-first redesign end to end on a TEMP `FY_HOME`, with no network. The daemon half is the
 * real `AgendaService` over the real file ledger, version archive and seen store; the CLI half drives the real `fy`
 * through HTTP into the daemon's real agenda routes, so a flag, a route and a ledger file all answer for one claim.
 * The pages in the app are proved by the PR that built each one; the `UI` tests name the file and the behaviour it
 * proves, so a deleted or renamed test breaks this checklist.
 *
 * WHAT THIS DOES NOT PROVE: pushes reaching a phone, a live tmux pane, or the real browser. Those are the integration
 * and visual tiers, which CI runs.
 */

const binaryName = 'fy';
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const REPO = resolve(import.meta.dir, '../../../..');
const SESSION = 'dod-session';
const START = Date.parse('2026-11-03T09:00:00.000Z');
const minute = (offset: number): string => new Date(START + offset * 60_000).toISOString();

const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION, name: 'Ada' };
const OWNER: AgendaActor = { kind: 'human' };

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};

const ask = (subject: string, extra: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'agent-raised',
  sourceRef: null,
  subject,
  title: subject.replace(/\?$/u, ''),
  why: 'The release waits on it.',
  premise: 'A release is ready to go out.',
  context: 'It changes the public service.',
  howToResolve: 'Answer in words.',
  ask: { kind: 'open-question' },
  ...extra,
});

const gate = (cardId: string): AgendaGate => ({
  cardId,
  laneId: 'tested',
  laneName: 'Ready to try',
  entry: 2,
  projectId: 'p1',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
});

interface Chat {
  messages: Array<{ messageId: string; at: string; text: string }>;
}

/** A daemon's agenda on a temp `FY_HOME`: real files, a clock the test moves, and ports the test can see. */
function build() {
  const home = mkdtempSync(join(tmpdir(), 'fy-dod-'));
  const sessionDirectory = (sessionId: string) => join(home, 'sessions', sessionId);
  const versions = new FileAgendaVersionStore(sessionDirectory, { spawn: inlineAgendaVersionsWorker });
  const repository = new FileAgendaLedgerRepository(sessionDirectory, undefined, undefined, undefined, versions);
  const seen = new FileAgendaSeenStore(sessionDirectory);
  const clock = { at: minute(0) };
  const pushed: string[] = [];
  const asking = new Map<string, { sessionId: string; id: string }>();
  const chat: Chat = { messages: [] };
  const ownerChat: OwnerChat = {
    find: async (_session, messageId) => {
      const found =
        messageId === undefined ? chat.messages.at(-1) : chat.messages.find(message => message.messageId === messageId);
      return found === undefined
        ? { ok: false, reason: messageId === undefined ? 'none' : 'unknown' }
        : { ok: true, message: found };
    },
  };
  const service = new AgendaService(
    repository,
    { now: () => clock.at },
    { has: async id => id === SESSION || id === 'child' },
    { raised: async (_session, item) => void pushed.push(item.id) },
    { changed: async () => undefined },
    undefined,
    DIRECTORY,
    undefined,
    undefined,
    { asking: async task => asking.get(task.id) as never },
    undefined,
    ownerChat,
    versions,
    seen,
  );
  return {
    home,
    repository,
    service,
    clock,
    pushed,
    asking,
    chat,
    at: (offset: number) => {
      clock.at = minute(offset);
    },
    items: async (): Promise<AgendaItem[]> => {
      const listed = await service.list(SESSION);
      if (!listed.ok) throw new Error(listed.error.message);
      return [...listed.value.items];
    },
    item: async (id: string): Promise<AgendaItem> => {
      const listed = await service.list(SESSION);
      if (!listed.ok) throw new Error(listed.error.message);
      const found = [...listed.value.items, ...listed.value.resolved].find(each => each.id === id);
      if (found === undefined) throw new Error(`no item ${id}`);
      return found as AgendaItem;
    },
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

type World = ReturnType<typeof build>;
const worlds: World[] = [];
const fresh = (): World => {
  const made = build();
  worlds.push(made);
  return made;
};
afterAll(() => {
  for (const each of worlds) each.dispose();
});

/** The real agenda routes behind a Bun server, for `fy` to call. */
function serveRoutes(made: World) {
  const credentials = {
    admin: 'admin-secret',
    warden: 'warden-secret',
    devices: { has: () => true, grants: () => DEFAULT_CAPABILITY_GRANTS },
    sessions: { resolve: async () => undefined },
  };
  const routes = agendaRoutes(
    made.service,
    { enrolledDevices: async () => 1, agendaDelivered: async () => 0 },
    { pending: async () => undefined, delivery: async () => undefined, sendNow: async () => undefined },
  );
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), credentials as never, NO_GOVERNED_ROUTES_GUARD);
  const headers = {
    authorization: 'Bearer admin-secret',
    'x-ferretry-client': 'cli',
    'x-ferretry-session-id': SESSION,
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async incoming => {
      const url = new URL(incoming.url);
      if (url.pathname === '/v1/health')
        return Response.json(
          health({
            features: [
              DAEMON_FEATURES.agendaConversation,
              DAEMON_FEATURES.agendaLinkMeaning,
              DAEMON_FEATURES.agendaChannel,
            ],
          }),
        );
      const body = incoming.method === 'GET' ? '' : await incoming.text();
      const response = await dispatcher.dispatch(
        apiRequest({
          method: incoming.method,
          path: url.pathname,
          headers: { ...headers, ...Object.fromEntries(incoming.headers), authorization: headers.authorization },
          query: [...url.searchParams],
          body,
        }),
      );
      return new Response(response.body, { status: response.status, headers: Object.fromEntries(response.headers) });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

let driver: CliDriver;
beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
});

const fy = (url: string, args: string[]) =>
  driver.run(['agenda', ...args, '--session', SESSION], {
    FY_URL: url,
    FY_TOKEN: 'admin-secret',
    FY_SESSION_ID: SESSION,
  });

const BRIEF = ['--premise', 'A release is ready.', '--context', 'The deploy needs a region.'];

/** A UI proof lives in another PR's test: it must exist and say the behaviour it proves. */
const proves = (path: string, ...phrases: string[]): void => {
  const file = join(REPO, path);
  should(existsSync(file)).equal(true, `${path} must exist: it proves this item`);
  const text = readFileSync(file, 'utf8');
  for (const phrase of phrases) should(text).containEql(phrase);
};
const landed = (path: string): boolean => existsSync(join(REPO, path));

describe(`Definition of done (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('DoD 1: a ferret only opens an agenda when no open one passes the test; otherwise it is told to join the closest', async () => {
    // Arrange
    const made = fresh();
    const daemon = serveRoutes(made);
    try {
      const first = await fy(daemon.url, ['add', 'Which region do we deploy to?', '--title', 'Region', ...BRIEF]);
      should(first.code).equal(0, first.err);

      // Act — a second ask on the same topic, with no word on why it is new
      const refused = await fy(daemon.url, ['add', 'Which region for the canary?', '--title', 'Canary', ...BRIEF]);
      const joined = await fy(daemon.url, [
        'add',
        'Which region for the canary?',
        '--title',
        'Canary',
        ...BRIEF,
        '--new',
        'The canary has its own rollout schedule.',
      ]);

      // Assert
      should(refused.code).not.equal(0);
      should(refused.err).containEql('Search, check, then open');
      should(refused.err).containEql('Should this join !A1?');
      should(refused.err).containEql('fy agenda edit A1');
      should(refused.err).containEql('--new');
      should(joined.code).equal(0, joined.err);
      should((await made.items()).map(item => item.id)).eql(['A1', 'A2']);
    } finally {
      daemon.stop();
    }
  });

  it('DoD 2: things that depend on each other are in one agenda: a card already asking points to the agenda that carries it', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Can you try the badge?'), AGENT));
    ok(await made.service.cardAsk(SESSION, 'A1', { kind: 'attach', ask: { gate: gate('F1') } }));
    made.asking.set('F1', { sessionId: SESSION, id: 'A1' });

    // Act — a second ask naming the same card
    const second = await made.service.raise(SESSION, ask('Is the badge colour right?', { task: { id: 'F1' } }), AGENT);

    // Assert — refused as a second ask, pointing at !A1, which carries the card
    should(second.ok).be.false();
    should(!second.ok && second.error.message).containEql('!A1');
    should(!second.ok && second.error.message).containEql('already asks the owner');
    should((await made.items()).map(item => item.id)).eql(['A1']);
  });

  it('DoD 3: Needs you is one queue, blockers first, each agenda once; a resting item never pushes', async () => {
    // Arrange — A1 and A2 ask; A3 blocks; A2 gets the owner's reply and rests
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    made.at(1);
    ok(await made.service.raise(SESSION, ask('Which cluster?'), AGENT));
    made.at(2);
    ok(await made.service.raise(SESSION, ask('Which quota?', { blockingNow: true }), AGENT));
    made.at(3);
    const pushedBefore = made.pushed.length;
    ok(await made.service.reply(SESSION, 'A2', OWNER, 'what is a cluster?'));
    ok(await made.service.rest(SESSION, 'A1', 'checking the region list', AGENT));

    // Act
    const items = await made.items();
    const queue = needsYouQueue([...items, ...items]).map(item => item.id);
    const resting = restingQueue(items).map(item => item.id);

    // Assert
    should(queue).eql(['A3']);
    should(resting.sort()).eql(['A1', 'A2']);
    should(made.pushed.length).equal(pushedBefore);
    should(made.pushed).eql(['A1', 'A2', 'A3']);
  });

  it('DoD 4: a reply rests the item; the ferret’s answer brings it back to its old spot; 30 minutes of silence get one nudge', async () => {
    // Arrange — A1 is older than A2, and the owner replies to A1
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    made.at(1);
    ok(await made.service.raise(SESSION, ask('Which cluster?'), AGENT));
    made.at(10);
    ok(await made.service.reply(SESSION, 'A1', OWNER, 'what is EU?'));
    const sent: string[] = [];
    const nudger = new AgendaRestNudger(
      made.repository,
      made.service,
      { enabled: async () => true, send: async (_s, sendId) => void sent.push(sendId), record: async () => undefined },
      () => [SESSION],
      { schedule: () => undefined, cancel: () => undefined },
      () => made.clock.at,
      'fy',
    );

    // Assert — resting, out of Needs you
    const rested = await made.item('A1');
    should(agendaState(rested)).containEql({ state: 'resting', sub: 'waiting-on-ferret' });
    should(needsYouQueue(await made.items()).map(item => item.id)).eql(['A2']);

    // Act — silence: nothing at 29 minutes, ONE nudge at 31, none again at 32
    made.at(10 + 29);
    const early = await nudger.sweep();
    made.at(10 + 31);
    const due = await nudger.sweep();
    made.at(10 + 32);
    const again = await nudger.sweep();
    should([early, due, again]).eql([0, 1, 0]);
    should(sent).have.length(1);

    // Act — the ferret answers on it
    made.at(10 + 40);
    ok(await made.service.edit(SESSION, 'A1', { questionAnswer: 'EU is Frankfurt.' }, AGENT));

    // Assert — back in Needs you, ahead of the newer A2: its old spot
    should(agendaState(await made.item('A1')).state).equal('needs-you');
    should(needsYouQueue(await made.items()).map(item => item.id)).eql(['A1', 'A2']);
  });

  it('DoD 5: snooze keeps an item resting until the time picked, unless a blocker wakes it', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    ok(await made.service.raise(SESSION, ask('Which cluster?'), AGENT));
    made.at(1);
    ok(await made.service.snooze(SESSION, 'A1', minute(60), OWNER));
    ok(await made.service.snooze(SESSION, 'A2', minute(60), OWNER));

    // Act — a timer tick before the time holds; a ferret marking A2 as blocking wakes it
    made.at(30);
    await made.service.wake(SESSION, 'A1');
    ok(await made.service.edit(SESSION, 'A2', { blockingNow: true }, AGENT));
    const held = await made.items();

    // Assert
    should(agendaState(held.find(item => item.id === 'A1') as AgendaItem).state).equal('snoozed');
    should(agendaState(held.find(item => item.id === 'A2') as AgendaItem).state).equal('needs-you');

    // Act — the time comes
    made.at(61);
    ok(await made.service.wake(SESSION, 'A1'));

    // Assert
    should(agendaState(await made.item('A1')).state).equal('needs-you');
  });

  it('DoD 6: a card that is ready shows its steps and Done / Not good inside its agenda, never as a separate item', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Can you try the badge?'), AGENT));

    // Act
    ok(
      await made.service.cardAsk(SESSION, 'A1', {
        kind: 'attach',
        ask: { gate: gate('F1'), howToTest: 'open the badge' },
      }),
    );
    const items = await made.items();
    const carried = items[0] as AgendaItem;

    // Assert
    should(items).have.length(1);
    should(carried.cardAsks?.map(each => each.gate.cardId)).eql(['F1']);
    should(carried.cardAsks?.[0]?.howToTest).equal('open the badge');
    should(carried.cardAsks?.[0]?.gate.options.map(option => option.label)).eql(['Done', 'Not good']);
    should(carried.gateAttached?.cardId).equal('F1');
  });

  it('DoD 7: an explainer or report you ask for appears in the agenda’s “where we are now”', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Walk me through the cache?', { stage: 'explainer' }), AGENT));

    // Act
    ok(await made.service.edit(SESSION, 'A1', { whereWeAre: 'The cache has three layers: L1, L2, disk.' }, AGENT));

    // Assert
    should((await made.item('A1')).whereWeAre).equal('The cache has three layers: L1, L2, disk.');
  });

  it('DoD 8: a 200k report round-trips whole, and every reply is in the conversation, in order', async () => {
    // Arrange
    const made = fresh();
    const report = `${'r'.repeat(199_990)}END-REPORT`;
    ok(await made.service.raise(SESSION, ask('Read the report?'), AGENT));

    // Act
    ok(await made.service.edit(SESSION, 'A1', { whereWeAre: report }, AGENT));
    for (const [index, words] of ['first reply', 'second reply', 'third reply'].entries()) {
      made.at(index + 1);
      ok(await made.service.reply(SESSION, 'A1', OWNER, words));
      made.at(index + 1.5);
      ok(await made.service.edit(SESSION, 'A1', { questionAnswer: `ferret answer ${index + 1}` }, AGENT));
    }
    const kept = await made.item('A1');
    const words: string[] = [];
    let cursor: { index: number; offset: number } | undefined = { index: 0, offset: 0 };
    while (cursor !== undefined) {
      const page = await made.service.conversationOf(SESSION, 'A1', cursor.index, cursor.offset);
      if (!page.ok) throw new Error(page.error.message);
      if (page.value.entry !== undefined) words.push(page.value.entry.text);
      cursor = page.value.next;
    }

    // Assert
    should(kept.whereWeAre).equal(report);
    should(words.filter(text => text.includes('reply'))).eql(['first reply', 'second reply', 'third reply']);
    should(words.indexOf('first reply')).be.below(words.indexOf('second reply'));
    should(words.indexOf('second reply')).be.below(words.indexOf('third reply'));
  });

  it('DoD 9: the versions list, and any two can be fetched to compare', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    made.at(1);
    ok(await made.service.edit(SESSION, 'A1', { whereWeAre: 'Checking the EU list.' }, AGENT));
    made.at(2);
    ok(await made.service.edit(SESSION, 'A1', { whereWeAre: 'The EU list has two regions.' }, AGENT));

    // Act
    const listed = await made.service.versionsOf(SESSION, 'A1');
    const first = await made.service.versionOf(SESSION, 'A1', 1);
    const last = await made.service.versionOf(SESSION, 'A1', 3);

    // Assert
    should(listed.ok && listed.value.versions.map(each => each.version)).eql([1, 2, 3]);
    should(first.ok && first.value.item.whereWeAre).be.undefined();
    should(last.ok && last.value.item.whereWeAre).equal('The EU list has two regions.');
  });

  it('DoD 10: merging two agendas keeps both conversations and all their cards', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    ok(await made.service.raise(SESSION, ask('Which cluster?'), AGENT));
    ok(await made.service.cardAsk(SESSION, 'A1', { kind: 'attach', ask: { gate: gate('F1') } }));
    ok(await made.service.cardAsk(SESSION, 'A2', { kind: 'attach', ask: { gate: gate('F2') } }));
    made.at(1);
    ok(await made.service.reply(SESSION, 'A1', OWNER, 'about the region'));
    ok(await made.service.reply(SESSION, 'A2', OWNER, 'about the cluster'));

    // Act
    made.at(2);
    ok(await made.service.merge(SESSION, 'A1', 'A2', AGENT));
    const kept = await made.item('A1');
    const absorbed = await made.item('A2');
    const page = await made.service.conversationOf(SESSION, 'A1', 0, 0);
    const total = page.ok ? page.value.total : -1;
    const texts: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const entry = await made.service.conversationOf(SESSION, 'A1', index, 0);
      if (entry.ok && entry.value.entry !== undefined) texts.push(entry.value.entry.text);
    }

    // Assert
    should(kept.cardAsks?.map(each => each.gate.cardId).sort()).eql(['F1', 'F2']);
    should(absorbed.mergedInto).equal('A1');
    should(texts.join('\n')).containEql('about the region');
    should(texts.join('\n')).containEql('about the cluster');
  });

  it('DoD 11: a sub-ferret can not create a card or an agenda without permission', async () => {
    // Arrange
    const made = fresh();
    const child: AgendaActor = { kind: 'agent', sessionId: 'child', name: 'Bo' };
    const board = new BoardService(
      boardWorld({ store: new MemoryBoardStore([card({ owner: 'lead', assignee: 'child' })]), subFerrets: DIRECTORY }),
    );

    // Act
    const agenda = await made.service.raise('child', ask('Can I open this?'), child);
    const cardRefused = await board
      .create(
        BoardTaskCreateRequestSchema.parse({ kind: 'feature', title: 'More', ask: { text: 'x', source: 'owner' } }),
        { kind: 'ferret', sessionId: 'child' },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    should(agenda).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(!agenda.ok && agenda.error.message).match(REFUSED);
    should(cardRefused).be.instanceOf(BoardError);
    should((cardRefused as BoardError).message).match(REFUSED);
  });

  it('DoD 12 (UI): a ferret can show a live card or mini board inline, and it updates when the card moves', () => {
    proves(
      'packages/pwa/tests/unit/fy-render-card-embed.test.tsx',
      'updates when a board.changed event says the card moved lane',
      'moves a card between lanes of a list board on board.changed',
    );
  });

  it('DoD 13: the board shows public cards by default: the owner’s own card is public, a ferret’s is private', () => {
    // Arrange
    const owners = card({ ask: { text: 'a card from the app', source: 'board' }, askedBy: 'person', parent: null });
    const ferrets = card({ ask: { text: 'a ferret idea', source: 'session:lead' }, askedBy: 'agent', parent: null });
    const subCard = card({ ask: { text: 'a sub-card', source: 'board' }, askedBy: 'person', parent: { id: 'F1' } });

    // Act
    const [mine, theirs, nested] = [owners, ferrets, subCard].map(each =>
      cardVisibility({ ...each, visibility: undefined }),
    );

    // Assert — and the app’s default view shows public cards only
    should(mine).equal('public');
    should(theirs).equal('private');
    should(nested).equal('private');
    proves(
      'packages/pwa/tests/unit/features/board-page.test.tsx',
      'hides a card the daemon calls private, even one a person asked for, and shows one it calls public',
    );
  });

  it('DoD 14: one agenda goes explainer → question → plan → tracker → test → done, and the history keeps every stage', async () => {
    // Arrange
    const made = fresh();
    const stages = ['explainer', 'question', 'plan', 'tracker', 'test'] as const;
    ok(await made.service.raise(SESSION, ask('Walk me through the cache?', { stage: 'explainer' }), AGENT));

    // Act / Assert — each step, in turn
    for (const [index, stage] of stages.entries()) {
      made.at(index + 1);
      if (index > 0) ok(await made.service.edit(SESSION, 'A1', { stage }, AGENT));
      const item = await made.item('A1');
      should(item.stage).equal(stage);
      should(agendaState(item).state).equal('needs-you');
      should(item.stages?.map(entry => entry.stage)).eql(stages.slice(0, index + 1));
    }
    made.at(10);
    ok(await made.service.resolve(SESSION, 'A1', AGENT, 'shipped'));
    const done = await made.item('A1');

    // Assert
    should(done.stage).equal('done');
    should(done.stages?.map(entry => entry.stage)).eql([...stages, 'done']);
  });

  it('DoD 15: a split links both ways and moves the card asks of the cards it moves', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    ok(await made.service.cardAsk(SESSION, 'A1', { kind: 'attach', ask: { gate: gate('F1') } }));
    ok(await made.service.cardAsk(SESSION, 'A1', { kind: 'attach', ask: { gate: gate('F2') } }));

    // Act
    made.at(1);
    ok(await made.service.split(SESSION, 'A1', ask('Is F2 right on its own?'), AGENT, [{ id: 'F2' }]));
    const parent = await made.item('A1');
    const child = await made.item('A2');

    // Assert
    should(child.splitFrom).equal('A1');
    should(parent.splitInto).containEql('A2');
    should(parent.cardAsks?.map(each => gateReference(each.gate))).eql([gateReference(gate('F1'))]);
    should(child.cardAsks?.map(each => gateReference(each.gate))).eql([gateReference(gate('F2'))]);
  });

  it('DoD 16: `fy agenda log` copies the owner’s chat words verbatim, tagged from chat, and the item rests until the ferret answers', async () => {
    // Arrange
    const made = fresh();
    const daemon = serveRoutes(made);
    try {
      const added = await fy(daemon.url, ['add', 'Which region do we deploy to?', '--title', 'Region', ...BRIEF]);
      should(added.code).equal(0, added.err);
      made.chat.messages.push({ messageId: 'm1', at: minute(1), text: '  use eu-west,\nnot us-east  ' });
      made.at(2);

      // Act
      const logged = await fy(daemon.url, ['log', 'A1', '--reply', 'Understood: eu-west.']);

      // Assert
      should(logged.code).equal(0, logged.err);
      const item = await made.item('A1');
      const conversation = item.conversation ?? [];
      should(conversation.find(entry => entry.by === 'owner')).containEql({
        text: '  use eu-west,\nnot us-east  ',
        fromChat: { messageId: 'm1', at: minute(1) },
      });
      should(conversation.some(entry => entry.by === 'ferret' && entry.text === 'Understood: eu-west.')).be.true();
      should(agendaState(item).state).equal('needs-you');
    } finally {
      daemon.stop();
    }
  });
});

describe('Definition of done: the pages that prove the items the app shows (UI)', () => {
  it('DoD 3 (UI): Needs you opens straight at its ask and a Resting item never buzzes', () => {
    proves('packages/pwa/tests/unit/agenda-tab.test.ts', 'agendaTabModel');
  });

  const pending = (path: string) => (landed(path) ? it : it.skip);

  pending('packages/pwa/tests/unit/features/agenda-version-diff.test.tsx')(
    'DoD 9 (UI): diff mode shows what changed between any two versions',
    () => proves('packages/pwa/tests/unit/features/agenda-version-diff.test.tsx'),
  );
  pending('packages/pwa/tests/unit/features/agenda-merge-control.test.tsx')(
    'DoD 10 (UI): the merge button merges two agendas',
    () => proves('packages/pwa/tests/unit/features/agenda-merge-control.test.tsx'),
  );
  pending('packages/pwa/tests/unit/agenda-conversation.test.ts')(
    'DoD 8 (UI): every reply shows in the conversation, in order',
    () => proves('packages/pwa/tests/unit/agenda-conversation.test.ts'),
  );
});
