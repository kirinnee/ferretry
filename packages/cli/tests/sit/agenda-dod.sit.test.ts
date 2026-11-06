import { afterAll, beforeAll, describe, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type AgendaGate,
  type AgendaItem,
  agendaNotificationPath,
  agendaState,
  BoardTaskCreateRequestSchema,
  type BoardTaskView,
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
import { KeyedSerialExecutor } from '../../../daemon/src/adapters/system/keyed-serial-executor.ts';
import {
  type AgendaActor,
  type AgendaMutation,
  AgendaService,
  type OwnerChat,
  type RaiseAgendaRequest,
} from '../../../daemon/src/lib/agenda/index.ts';
import { AgendaRestNudger } from '../../../daemon/src/lib/agenda/rest-nudge.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../daemon/src/lib/api/capability.ts';
import { ApiDispatcher, ApiRouter } from '../../../daemon/src/lib/api/index.ts';
import { BoardError, BoardService, cardVisibility } from '../../../daemon/src/lib/board/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../daemon/src/lib/grants/index.ts';
import { NotificationService } from '../../../daemon/src/lib/notifications/service.ts';
import type {
  NotificationDeliveryLedger,
  NotificationLedgerEntry,
  NotificationRecord,
} from '../../../daemon/src/lib/notifications/types.ts';
import type { PushDispatch } from '../../../daemon/src/lib/push/types.ts';
import { agendaRoutes } from '../../../daemon/src/lib/runtime/index.ts';
import { inlineAgendaVersionsWorker } from '../../../daemon/tests/support/agenda-versions-worker.ts';
import { request as apiRequest } from '../../../daemon/tests/unit/api/support.ts';
import { world as boardWorld, card, MemoryBoardStore } from '../../../daemon/tests/unit/board/support.ts';
import { DIRECTORY, REFUSED } from '../../../daemon/tests/unit/sub-ferret/support.ts';
import pkg from '../../package.json' with { type: 'json' };
import { card as taskCard, taskResponse } from '../unit/board/fixtures';
import { health } from '../unit/daemon/fixtures';
import { BinaryCliDriver, type CliDriver, InProcessCliDriver } from './driver';

/**
 * THE DEFINITION OF DONE, ITEM BY ITEM (docs/agenda.md § Definition of done). Each test is named `DoD <n>: <spec words>`
 * so the checklist reads straight from the test output.
 *
 * WHAT THIS PROVES: the agenda-first redesign end to end on a TEMP `FY_HOME`, with no network. The daemon half is the
 * real `AgendaService` over the real file ledger, version archive and seen store. Items 1, 2, 7, 8 (the report), 10, 14,
 * 15 and 16 are driven through the real `fy` over HTTP into the daemon's real agenda routes, so a flag, a route and a
 * ledger file all answer for one claim. Items 3, 4, 5, 6, 8 (the replies), 9, 11 and 13 are service-level checks: the
 * owner's side (a reply, a snooze, the clock, the push) has no `fy` command, so the test calls the service the app's
 * routes call. The pages in the app are proved by the PR that built each one; the `UI` tests name the file and the
 * behaviour it proves, so a deleted or renamed test breaks this checklist.
 *
 * WHAT THIS DOES NOT PROVE: a push reaching a phone, a live tmux pane, or the real browser. Those are the integration
 * and visual tiers, which CI runs.
 */

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
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

/** The push ledger in memory: the notification service decides from it, the test reads what it recorded. */
class MemoryPushLedger implements NotificationDeliveryLedger {
  readonly records: NotificationRecord[] = [];

  async find(key: string): Promise<NotificationLedgerEntry | undefined> {
    const requested = this.records.find(record => record.key === key && record.phase === 'requested');
    if (requested === undefined || requested.phase !== 'requested') return undefined;
    const outcome = this.records.find(record => record.key === key && record.phase === 'outcome');
    return { requested, ...(outcome === undefined || outcome.phase !== 'outcome' ? {} : { outcome }) };
  }

  async entries(): Promise<readonly NotificationLedgerEntry[]> {
    const keys = this.records.filter(record => record.phase === 'requested').map(record => record.key);
    const found = await Promise.all(keys.map(async key => await this.find(key)));
    return found.filter(entry => entry !== undefined);
  }

  async append(record: NotificationRecord): Promise<void> {
    this.records.push(record);
  }
}

/** A daemon's agenda on a temp `FY_HOME`: real files, a clock the test moves, and ports the test can see. */
function build() {
  const home = mkdtempSync(join(tmpdir(), 'fy-dod-'));
  const sessionDirectory = (sessionId: string) => join(home, 'sessions', sessionId);
  const versions = new FileAgendaVersionStore(sessionDirectory, { spawn: inlineAgendaVersionsWorker });
  const repository = new FileAgendaLedgerRepository(sessionDirectory, undefined, undefined, undefined, versions);
  const seen = new FileAgendaSeenStore(sessionDirectory);
  const clock = { at: minute(0) };
  const asking = new Map<string, { sessionId: string; id: string }>();
  const cards = new Map<string, BoardTaskView>();
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
    { has: async id => id === SESSION || id === 'child' || id === 'lead' },
    { raised: async () => undefined },
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
    asking,
    cards,
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
    /** The real notification service, with a recording sender: what the daemon does when the ferret stops. */
    buzz: () => {
      const dispatches: PushDispatch[] = [];
      const ledger = new MemoryPushLedger();
      const notifications = new NotificationService({
        ledger,
        sessions: { describe: async () => ({ name: 'Ada', title: 'Ship the release', interactive: true }) },
        push: {
          list: async () => [{}],
          notify: async dispatch => {
            dispatches.push(dispatch);
            return { delivered: 1, failed: 0 };
          },
        },
        serial: new KeyedSerialExecutor(),
        clock: { now: () => clock.at },
      });
      return {
        dispatches,
        recorded: () => ledger.records.length,
        stopped: async (stoppedAt: string) => {
          const listed = await service.list(SESSION);
          if (!listed.ok) throw new Error(listed.error.message);
          await notifications.stopped(SESSION, stoppedAt, listed.value);
        },
      };
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

/** The real agenda routes behind a Bun server, for `fy` to call; the board's card route answers from `made.cards`. */
function serveRoutes(made: World) {
  const credentials = {
    admin: 'admin-secret',
    warden: 'warden-secret',
    devices: { has: () => true, grants: () => DEFAULT_CAPABILITY_GRANTS },
    sessions: { resolve: async () => undefined },
  };
  const routes = agendaRoutes(
    made.service,
    { enrolledDevices: async () => 1 },
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
              DAEMON_FEATURES.agendaTask,
              DAEMON_FEATURES.agendaTabs,
            ],
          }),
        );
      const boardCard = url.pathname.match(/^\/v1\/board\/tasks\/([^/]+)$/u)?.[1];
      if (boardCard !== undefined) {
        const found = made.cards.get(decodeURIComponent(boardCard));
        return found === undefined
          ? Response.json({ error: { code: 'not_found', message: 'no such card' } }, { status: 404 })
          : Response.json(taskResponse(found));
      }
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

/** One `fy agenda …` call on the world's temp home, as the ferret session. */
const fy = (made: World, url: string, args: string[]) =>
  driver.run(['agenda', ...args, '--session', SESSION], {
    FY_HOME: made.home,
    FY_URL: url,
    FY_TOKEN: 'admin-secret',
    FY_SESSION_ID: SESSION,
  });

const BRIEF = ['--premise', 'A release is ready.', '--context', 'The deploy needs a region.'];

/** A proof lives in another test file: it must exist and say the behaviour it proves. */
const proves = (path: string, ...phrases: string[]): void => {
  const file = join(REPO, path);
  should(existsSync(file)).equal(true, `${path} must exist: it proves this item`);
  const text = readFileSync(file, 'utf8');
  for (const phrase of phrases) should(text).containEql(phrase);
};

describe(`Definition of done (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('DoD 1: a ferret only opens an agenda when no open one passes the test; otherwise it adds to the closest', async () => {
    // Arrange
    const made = fresh();
    const daemon = serveRoutes(made);
    try {
      const first = await fy(made, daemon.url, ['add', 'Which region do we deploy to?', '--title', 'Region', ...BRIEF]);
      should(first.code).equal(0, first.err);

      // Act — a second ask on the same topic, with no word on why it is new
      const refused = await fy(made, daemon.url, [
        'add',
        'Which region for the canary?',
        '--title',
        'Canary',
        ...BRIEF,
      ]);

      // Assert — nothing opened; the listing names the candidate and the join command
      should(refused.code).not.equal(0);
      should(refused.err).containEql('Search, check, then open');
      should(refused.err).containEql('Should this join !A1?');
      should(refused.err).containEql('fy agenda edit A1');
      should(refused.err).containEql('--new');
      should((await made.items()).map(item => item.id)).eql(['A1']);

      // Act — the ferret adds to the closest, as the listing says
      const joined = await fy(made, daemon.url, ['edit', 'A1', '--where', 'The canary region is decided here too.']);

      // Assert — still ONE agenda, now carrying the canary
      should(joined.code).equal(0, joined.err);
      should((await made.items()).map(item => item.id)).eql(['A1']);
      should((await made.item('A1')).whereWeAre).containEql('The canary region is decided here too.');

      // Act — only a reason that none passes opens a second one
      const opened = await fy(made, daemon.url, [
        'add',
        'Which region for the canary?',
        '--title',
        'Canary',
        ...BRIEF,
        '--new',
        'The canary has its own rollout schedule.',
      ]);

      // Assert
      should(opened.code).equal(0, opened.err);
      should((await made.items()).map(item => item.id)).eql(['A1', 'A2']);
    } finally {
      daemon.stop();
    }
  });

  it('DoD 2: things that depend on each other are always in one agenda: the listing puts the agenda carrying a dependency first', async () => {
    // Arrange — A2 carries F1; F2 depends on F1; F3 blocks F1. A1 is older and shares the new ask's words, so ONLY the
    // tie can put A2 first.
    const made = fresh();
    made.cards.set('F1', taskCard({ id: 'F1' }));
    made.cards.set('F2', taskCard({ id: 'F2', dependsOn: [{ task: { id: 'F1' }, until: 'shipped' }] }));
    made.cards.set('F3', taskCard({ id: 'F3', blocks: [{ id: 'F1' }] }));
    const daemon = serveRoutes(made);
    try {
      ok(await made.service.raise(SESSION, ask('Is the badge colour right for dark mode?'), AGENT));
      ok(await made.service.raise(SESSION, ask('Which region?', { task: { id: 'F1' } }), AGENT));

      // Act
      const dependent = await fy(made, daemon.url, [
        'add',
        'Is the badge colour right?',
        '--title',
        'Colour',
        '--task',
        'F2',
        ...BRIEF,
      ]);
      const blocking = await fy(made, daemon.url, [
        'add',
        'Is the badge ready to ship?',
        '--title',
        'Ship',
        '--task',
        'F3',
        ...BRIEF,
      ]);

      // Assert — neither opened; each says WHY !A2 is the one to join, and lists it before the word-matching !A1
      should(dependent.code).not.equal(0);
      should(dependent.err).containEql('carries &F1, which &F2 depends on');
      should(dependent.err).containEql('Should this join !A2?');
      should(dependent.err.indexOf('!A2')).be.aboveOrEqual(0);
      should(dependent.err.indexOf('!A1')).be.aboveOrEqual(0);
      should(dependent.err.indexOf('!A2')).be.below(dependent.err.indexOf('!A1'));
      should(blocking.code).not.equal(0);
      should(blocking.err).containEql('carries &F1, which depends on &F3');
      should((await made.items()).map(item => item.id)).eql(['A1', 'A2']);
    } finally {
      daemon.stop();
    }
  });

  it('DoD 2: a card that already asks is never asked about twice: the second ask is refused and points at the agenda carrying it', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Can you try the badge?'), AGENT));
    ok(await made.service.cardAsk(SESSION, 'A1', { kind: 'attach', ask: { gate: gate('F1') } }));
    made.asking.set('F1', { sessionId: SESSION, id: 'A1' });

    // Act — a second ask naming the same card
    const second = await made.service.raise(SESSION, ask('Is the badge colour right?', { task: { id: 'F1' } }), AGENT);

    // Assert
    should(second.ok).be.false();
    should(!second.ok && second.error.message).containEql('!A1');
    should(!second.ok && second.error.message).containEql('already asks the owner');
    should((await made.items()).map(item => item.id)).eql(['A1']);
  });

  it('DoD 3: Needs you notifies once and puts blockers first; a Resting or snoozed item never buzzes', async () => {
    // Arrange — a quiet board: A1 the owner replied to, A2 snoozed
    const quiet = fresh();
    ok(await quiet.service.raise(SESSION, ask('Which region?'), AGENT));
    ok(await quiet.service.raise(SESSION, ask('Which cluster?'), AGENT));
    quiet.at(1);
    ok(await quiet.service.reply(SESSION, 'A1', OWNER, 'what is a region?'));
    ok(await quiet.service.snooze(SESSION, 'A2', minute(60), OWNER));
    const silent = quiet.buzz();

    // Act — the ferret stops
    await silent.stopped(minute(5));

    // Assert — nothing sent, nothing recorded
    should(silent.dispatches).have.length(0);
    should(silent.recorded()).equal(0);

    // Arrange — A1 asks first, A2 next, A3 blocks; the owner replies to A2, so it rests; A1 is older and not blocking
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    made.at(1);
    ok(await made.service.raise(SESSION, ask('Which cluster?'), AGENT));
    made.at(2);
    ok(await made.service.raise(SESSION, ask('Which quota?', { blockingNow: true }), AGENT));
    made.at(3);
    ok(await made.service.reply(SESSION, 'A2', OWNER, 'what is a cluster?'));
    const items = await made.items();
    const buzzing = made.buzz();

    // Act
    const queue = needsYouQueue([...items, ...items]).map(item => item.id);
    await buzzing.stopped(minute(5));
    await buzzing.stopped(minute(5));

    // Assert — one queue, each agenda once, the blocker first
    should(queue).eql(['A3', 'A1']);
    should(restingQueue(items).map(item => item.id)).eql(['A2']);
    // Assert — ONE push for the stop, opening straight at the blocker's ask
    should(buzzing.dispatches).have.length(1);
    should(buzzing.dispatches[0]?.payload.url).equal(agendaNotificationPath(SESSION, 'A3'));
    should(buzzing.dispatches[0]?.payload.title).containEql('2 need you');
  });

  it('DoD 4: a reply or an answer rests the item; the ferret’s answer brings it back to its old spot; 30 minutes of silence get one nudge', async () => {
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
      binaryName,
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

  it('DoD 4: an ANSWER from the owner leaves Needs you too', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?', { ask: { kind: 'open-question' } }), AGENT));
    ok(await made.service.raise(SESSION, ask('Which cluster?'), AGENT));
    made.at(1);

    // Act — the owner answers A1's ask in the app
    ok(await made.service.answer(SESSION, 'A1', { kind: 'open-question', answer: 'eu-west' }, OWNER));

    // Assert — A1 rests, waiting on the ferret (it is not closed), and A2 alone is left for the owner
    should(agendaState(await made.item('A1'))).containEql({ state: 'resting', sub: 'waiting-on-ferret' });
    should(restingQueue(await made.items()).map(item => item.id)).eql(['A1']);
    should(needsYouQueue(await made.items()).map(item => item.id)).eql(['A2']);
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

  it('DoD 6 (board): a card reaching its gate puts the ask on the open agenda that carries it, and opens none', () => {
    proves(
      'packages/daemon/tests/unit/board/card-asks.test.ts',
      'opens ONE agenda named after the card, carrying its How to test and Done / Not good (DoD 6)',
      'puts the ask on the open agenda that already carries the card, and opens none',
    );
  });

  it('DoD 7: an explainer or report you ask for appears in the agenda’s body, under a short “where we are now”', async () => {
    // Arrange
    const made = fresh();
    const daemon = serveRoutes(made);
    const explainer = join(made.home, 'explainer.md');
    const rewritten = join(made.home, 'explainer-v2.md');
    writeFileSync(explainer, '## How the cache works\n\n- L1 is memory\n- L2 is the shared store\n- Disk is last');
    writeFileSync(rewritten, '## How the cache works\n\n- L1 is memory\n- Disk is last: L2 is gone');
    try {
      const added = await fy(made, daemon.url, [
        'add',
        'Walk me through the cache?',
        '--title',
        'Cache',
        '--stage',
        'explainer',
        ...BRIEF,
      ]);
      should(added.code).equal(0, added.err);

      // Act — the explainer is the body; "where we are now" is the short status above it
      const edited = await fy(made, daemon.url, [
        'edit',
        'A1',
        '--where',
        'The explainer is ready to read.',
        '--body-file',
        explainer,
      ]);
      const again = await fy(made, daemon.url, ['edit', 'A1', '--body-file', rewritten]);

      // Assert — the body holds the whole current state: a rewrite replaces it, never appends to it
      should(edited.code).equal(0, edited.err);
      should(again.code).equal(0, again.err);
      const item = await made.item('A1');
      should(item.whereWeAre).equal('The explainer is ready to read.');
      should(item.body).equal(readFileSync(rewritten, 'utf8'));
    } finally {
      daemon.stop();
    }
  });

  it('DoD 7: the tabs are written whole through `edit`, read back whole, and one edit is one version (&F923)', async () => {
    // Arrange
    const made = fresh();
    const daemon = serveRoutes(made);
    const now = join(made.home, 'now.md');
    const decisions = join(made.home, 'decisions.md');
    const risks = join(made.home, 'risks.md');
    writeFileSync(now, '## Status\n\n| Step | State |\n| --- | --- |\n| Config | done |');
    writeFileSync(decisions, '1. **SQLite**, with WAL.');
    writeFileSync(risks, '- The export may slip.');
    try {
      const added = await fy(made, daemon.url, ['add', 'Read the plan?', '--title', 'Plan', ...BRIEF]);
      should(added.code).equal(0, added.err);

      // Act — the main tab, and two tabs of the ferret's own, in ONE edit
      const edited = await fy(made, daemon.url, [
        'edit',
        'A1',
        '--where-file',
        now,
        '--tab-file',
        `Decisions=${decisions}`,
        '--tab-file',
        `Risks=${risks}`,
      ]);
      const shown = await fy(made, daemon.url, ['show', 'A1', '--tab', 'Decisions']);

      // Assert — read back whole, in order, and one edit is one revision
      should(edited.code).equal(0, edited.err);
      should(shown.code).equal(0, shown.err);
      should(shown.out.trim()).equal(readFileSync(decisions, 'utf8'));
      const item = await made.item('A1');
      should(item.whereWeAre).equal(readFileSync(now, 'utf8'));
      should(item.tabs?.map(tab => tab.name)).deepEqual(['Decisions', 'Risks']);
      should(item.revisions).have.length(1);
    } finally {
      daemon.stop();
    }
  });

  it('DoD 8: a 200k report round-trips whole through `fy agenda edit --body-file`', async () => {
    // Arrange
    const made = fresh();
    const daemon = serveRoutes(made);
    const report = `${'r'.repeat(199_990)}END-REPORT`;
    const file = join(made.home, 'report.md');
    writeFileSync(file, report);
    try {
      const added = await fy(made, daemon.url, ['add', 'Read the report?', '--title', 'Report', ...BRIEF]);
      should(added.code).equal(0, added.err);

      // Act
      const edited = await fy(made, daemon.url, ['edit', 'A1', '--body-file', file]);

      // Assert — read back whole: the same length, the same last words, nothing cut
      should(edited.code).equal(0, edited.err);
      const kept = (await made.item('A1')).body ?? '';
      should(kept.length).equal(report.length);
      should(kept.endsWith('END-REPORT')).be.true();
      should(kept === report).be.true();
    } finally {
      daemon.stop();
    }
  });

  it('DoD 8: every reply shows in the conversation, in order, the ferret’s answers between them', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Read the report?'), AGENT));

    // Act
    for (const [index, words] of ['first reply', 'second reply', 'third reply'].entries()) {
      made.at(index + 1);
      ok(await made.service.reply(SESSION, 'A1', OWNER, words));
      made.at(index + 1.5);
      ok(await made.service.edit(SESSION, 'A1', { questionAnswer: `ferret answer ${index + 1}` }, AGENT));
    }
    const words: string[] = [];
    let cursor: { index: number; offset: number } | undefined = { index: 0, offset: 0 };
    while (cursor !== undefined) {
      const page = await made.service.conversationOf(SESSION, 'A1', cursor.index, cursor.offset);
      if (!page.ok) throw new Error(page.error.message);
      if (page.value.entry !== undefined) words.push(page.value.entry.text);
      cursor = page.value.next;
    }

    // Assert — the owner’s words and the ferret’s, interleaved exactly as they happened
    should(words.filter(text => /reply|ferret answer/u.test(text))).eql([
      'first reply',
      'ferret answer 1',
      'second reply',
      'ferret answer 2',
      'third reply',
      'ferret answer 3',
    ]);
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
    const daemon = serveRoutes(made);
    try {
      // Act — the ferret merges A2 into A1
      made.at(2);
      const merged = await fy(made, daemon.url, ['merge', 'A1', 'A2']);
      should(merged.code).equal(0, merged.err);
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
    } finally {
      daemon.stop();
    }
  });

  it('DoD 11: a sub-ferret can not create a card or an agenda without permission; its lead can', async () => {
    // Arrange
    const made = fresh();
    const child: AgendaActor = { kind: 'agent', sessionId: 'child', name: 'Bo' };
    const lead: AgendaActor = { kind: 'agent', sessionId: 'lead', name: 'Lee' };
    const board = new BoardService(
      boardWorld({
        store: new MemoryBoardStore([card({ owner: 'lead', assignee: 'child' })]),
        subFerrets: DIRECTORY,
      }),
    );
    const create = BoardTaskCreateRequestSchema.parse({
      kind: 'feature',
      title: 'More',
      ask: { text: 'x', source: 'owner' },
    });

    // Act
    const agenda = await made.service.raise('child', ask('Can I open this?'), child);
    const cardRefused = await board.create(create, { kind: 'ferret', sessionId: 'child' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const leadAgenda = await made.service.raise('lead', ask('May I open this?'), lead);
    const leadCard = await board.create(create, { kind: 'ferret', sessionId: 'lead' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — refused for the sub-ferret, allowed for the lead
    should(agenda).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(!agenda.ok && agenda.error.message).match(REFUSED);
    should(cardRefused).be.instanceOf(BoardError);
    should((cardRefused as BoardError).message).match(REFUSED);
    should(leadAgenda.ok).be.true();
    should(leadCard).be.undefined();
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
    const daemon = serveRoutes(made);
    const stages = ['explainer', 'question', 'plan', 'tracker', 'test'] as const;
    try {
      const added = await fy(made, daemon.url, [
        'add',
        'Walk me through the cache?',
        '--title',
        'Cache',
        '--stage',
        'explainer',
        ...BRIEF,
      ]);
      should(added.code).equal(0, added.err);

      // Act / Assert — each step, in turn, through the CLI
      for (const [index, stage] of stages.entries()) {
        made.at(index + 1);
        if (index > 0) {
          const moved = await fy(made, daemon.url, ['edit', 'A1', '--stage', stage]);
          should(moved.code).equal(0, moved.err);
        }
        const item = await made.item('A1');
        should(item.stage).equal(stage);
        should(agendaState(item).state).equal('needs-you');
        should(item.stages?.map(entry => entry.stage)).eql(stages.slice(0, index + 1));
      }
      made.at(10);
      const done = await fy(made, daemon.url, ['done', 'A1', '--note', 'shipped']);
      should(done.code).equal(0, done.err);
      const finished = await made.item('A1');

      // Assert
      should(finished.stage).equal('done');
      should(finished.stages?.map(entry => entry.stage)).eql([...stages, 'done']);
    } finally {
      daemon.stop();
    }
  });

  it('DoD 15: a split links both ways and moves the card asks of the cards it moves', async () => {
    // Arrange
    const made = fresh();
    ok(await made.service.raise(SESSION, ask('Which region?'), AGENT));
    ok(await made.service.cardAsk(SESSION, 'A1', { kind: 'attach', ask: { gate: gate('F1') } }));
    ok(await made.service.cardAsk(SESSION, 'A1', { kind: 'attach', ask: { gate: gate('F2') } }));
    const daemon = serveRoutes(made);
    try {
      // Act — the ferret splits F2 off, through the CLI
      made.at(1);
      const split = await fy(made, daemon.url, [
        'split',
        'A1',
        'Is F2 right on its own?',
        '--title',
        'F2 on its own',
        ...BRIEF,
        '--move-cards',
        'F2',
      ]);
      should(split.code).equal(0, split.err);
      const parent = await made.item('A1');
      const child = await made.item('A2');

      // Assert
      should(child.splitFrom).equal('A1');
      should(parent.splitInto).containEql('A2');
      should(parent.cardAsks?.map(each => gateReference(each.gate))).eql([gateReference(gate('F1'))]);
      should(child.cardAsks?.map(each => gateReference(each.gate))).eql([gateReference(gate('F2'))]);
    } finally {
      daemon.stop();
    }
  });

  it('DoD 16: `fy agenda log` copies the owner’s chat words verbatim, tagged from chat; the ferret’s answer brings the item back to its old spot', async () => {
    // Arrange — A1 is the older agenda, A2 a newer one
    const made = fresh();
    const daemon = serveRoutes(made);
    try {
      const added = await fy(made, daemon.url, ['add', 'Which region do we deploy to?', '--title', 'Region', ...BRIEF]);
      should(added.code).equal(0, added.err);
      made.at(1);
      ok(await made.service.raise(SESSION, ask('Which cluster?'), AGENT));
      made.chat.messages.push({ messageId: 'm1', at: minute(2), text: '  use eu-west,\nnot us-east  ' });
      made.at(3);

      // Act
      const logged = await fy(made, daemon.url, ['log', 'A1', '--reply', 'Understood: eu-west.']);

      // Assert — the words verbatim, tagged, with the ferret's reply
      should(logged.code).equal(0, logged.err);
      const item = await made.item('A1');
      const conversation = item.conversation ?? [];
      should(conversation.find(entry => entry.by === 'owner')).containEql({
        text: '  use eu-west,\nnot us-east  ',
        fromChat: { messageId: 'm1', at: minute(2) },
      });
      should(conversation.some(entry => entry.by === 'ferret' && entry.text === 'Understood: eu-west.')).be.true();

      // Assert — it came back AHEAD of the newer A2: its old spot
      should(agendaState(item).state).equal('needs-you');
      should(needsYouQueue(await made.items()).map(each => each.id)).eql(['A1', 'A2']);

      // Assert — the same chat message is never logged twice
      const again = await fy(made, daemon.url, ['log', 'A1', '--message', 'm1', '--reply', 'Understood again.']);
      should(again.code).not.equal(0);
      should((await made.item('A1')).conversation?.filter(entry => entry.by === 'owner')).have.length(1);
    } finally {
      daemon.stop();
    }
  });

  it('DoD 16: `fy agenda log --rest` leaves the item resting as working', async () => {
    // Arrange
    const made = fresh();
    const daemon = serveRoutes(made);
    try {
      const added = await fy(made, daemon.url, ['add', 'Which region do we deploy to?', '--title', 'Region', ...BRIEF]);
      should(added.code).equal(0, added.err);
      made.chat.messages.push({ messageId: 'm1', at: minute(1), text: 'look into eu-west' });
      made.at(2);

      // Act
      const logged = await fy(made, daemon.url, ['log', 'A1', '--rest', 'Checking the EU list.']);

      // Assert
      should(logged.code).equal(0, logged.err);
      should(agendaState(await made.item('A1'))).containEql({ state: 'resting', sub: 'working' });
      const listed = await made.service.versionsOf(SESSION, 'A1');
      const last = listed.ok ? listed.value.versions.at(-1)?.version : undefined;
      const stored = last === undefined ? undefined : await made.service.versionOf(SESSION, 'A1', last);
      should(stored?.ok && agendaState(stored.value.item as AgendaItem).state).equal('resting');
    } finally {
      daemon.stop();
    }
  });
});

/**
 * The pages that prove what the app shows. Each points at a test file and the behaviour it names: a missing or renamed
 * test file, or a lost phrase, FAILS the checklist. Both pages are on main, so no pointer waits.
 */

describe('Definition of done: the pages that prove the items the app shows (UI)', () => {
  const itemPage = it;
  const diffPage = it;
  const parts = 'packages/pwa/tests/unit/features/agenda-item-parts.test.tsx';

  itemPage('DoD 3 (UI): a push or a link opens the item AT ITS ASK', () => {
    proves('packages/pwa/tests/unit/features/agenda-inbox-notification-open.test.tsx', 'opens it AT ITS ASK');
    proves(parts, 'a push or a link that names the item scrolls to "What I need from you" and focuses it');
  });
  itemPage('DoD 6 (UI): the ask and every card ask sit inside the item, never docked', () => {
    proves(parts, 'holds the ask and EVERY card ask, each with its own buttons, inside the item — never docked');
  });
  itemPage(
    'DoD 7 (UI): the report the owner asked for shows whole in the tabs, the main tab “where we are now” first',
    () => {
      proves(parts, 'holds the report the owner asked for in the body, open and whole — no cut-off, however long');
      proves(parts, 'opens first: decided so far and still open at its top, then where things stand');
    },
  );
  itemPage('DoD 8 (UI): a reply is drawn whole, however long, and every reply in order', () => {
    proves(
      'packages/pwa/tests/unit/features/agenda-item-history.test.tsx',
      'draws a reply WHOLE, however long, and every reply in order',
    );
  });
  itemPage('DoD 9 (UI): the detailed context, the terms, the conversation and the activity log are folded', () => {
    proves(
      'packages/pwa/tests/unit/agenda-item-sections.test.ts',
      'are in the spec’s order, with the detailed context, the terms and references, the conversation and the activity log folded',
    );
    proves(
      parts,
      'the detailed context, the terms and references, the conversation and the activity log start closed, and open on a tap',
    );
  });
  itemPage('DoD 14 (UI): the head shows the stage the agenda is at now', () => {
    proves(parts, 'the head says where the item stands and the stage it is at now');
  });
  diffPage('DoD 9 (UI): diff mode shows what changed between any two versions', () => {
    proves(
      'packages/pwa/tests/unit/features/agenda-version-diff.test.tsx',
      'lets the owner pick any two versions, in whichever order',
      'defaults to what changed since this device last looked',
    );
  });
  diffPage(
    'DoD 10 (UI): the merge button lists the open agendas, then says what will happen before sending anything',
    () => {
      proves(
        'packages/pwa/tests/unit/features/agenda-merge-control.test.tsx',
        'lists the open agendas, then says what will happen before sending anything',
      );
    },
  );
  diffPage('DoD 15 (UI): a split says where it came from and where it went', () => {
    proves(
      'packages/pwa/tests/unit/features/agenda-merge-control.test.tsx',
      'says where a split came from and where it went',
    );
  });
  diffPage('DoD 8 (UI): the conversation is one event per stored entry, in stored order', () => {
    proves('packages/pwa/tests/unit/agenda-conversation.test.ts', 'is one event per stored entry, in stored order');
  });
});
