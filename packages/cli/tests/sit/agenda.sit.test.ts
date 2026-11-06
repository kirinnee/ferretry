import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENDA_SCHEMA_VERSION,
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  type AgendaItem,
  AgendaItemSchema,
  type AgendaSnapshot,
  agendaBriefOf,
  DAEMON_FEATURES,
  type ResolvedAgendaItem,
  ResolvedAgendaItemSchema,
} from '@ferretry/protocol';
import should from 'should';
import { type AgendaLedger, applyAgendaCommandToSession } from '../../../daemon/src/lib/agenda/state-machine.ts';
import pkg from '../../package.json' with { type: 'json' };
import { health } from '../unit/daemon/fixtures';
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

// SIT journeys; SIT_DRIVER picks the compiled binary (no coverage) or in-process (coverage). See
// cli.sit.test.ts for the shared rationale.
const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const SESSION = 'sit-agenda-session';
const EPOCH = new Date(0).toISOString();

/**
 * A minimal stand-in for `fyd`'s agenda route, not `fyd` itself.
 *
 * WHAT THIS PROVES: a real compiled `fy` binary, over a real HTTP round trip (retries, headers,
 * timeouts, schema parsing all included), driving the whole CLI-visible lifecycle a human cares
 * about — raise, active listing, answer/dismiss, immediate absence, and a history entry carrying the
 * exact typed response — across all four ask kinds. Every item this server hands back is constructed
 * through `AgendaItemSchema`/`ResolvedAgendaItemSchema`, so a mismatch with the real wire
 * contract fails here too, not just in the CLI's own unit tests.
 *
 * WHAT THIS DOES NOT PROVE: anything inside the real daemon. `applyToLedger()`, its authorization
 * predicates, and the session-registry check the real route makes before it will even look at a
 * board (`AgendaSessionDirectory.has`, backed by the live session registry in
 * `packages/daemon/bin/fyd.ts`) belong to `packages/daemon/tests/unit/agenda/{service,
 * state-machine}.test.ts`. This repo's SIT tier is deliberately CLI-only and black-box — no SIT
 * journey anywhere spawns a live `fyd` — so this doubles the daemon at exactly the seam the CLI's own
 * transport speaks.
 */
class FakeAgendaDaemon {
  readonly #items: AgendaItem[] = [];
  readonly #resolved: ResolvedAgendaItem[] = [];
  #ordinal = 0;
  #conversations: AgendaLedger['conversations'];
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.#server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => this.#handle(request) });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  stop(): void {
    this.#server.stop(true);
  }

  /** An item the daemon itself opened, as it would on a card's behalf: the CLI never raises one. */
  seed(item: AgendaItem): void {
    this.#items.push(item);
  }

  #snapshot(): AgendaSnapshot {
    return {
      v: AGENDA_SCHEMA_VERSION,
      sessionId: SESSION,
      items: this.#items,
      resolved: this.#resolved,
      count: this.#items.length,
      parseErrors: 0,
      updatedAt: EPOCH,
    };
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const session = `/v1/sessions/${encodeURIComponent(SESSION)}`;
    if (path === '/v1/health' && request.method === 'GET') {
      return Response.json(
        health({ features: [DAEMON_FEATURES.agendaConversation, DAEMON_FEATURES.agendaLinkMeaning] }),
      );
    }
    // A daemon of this build answers the agenda route and refuses anything else the way the real one does.
    if (path !== `${session}/agenda`) {
      return Response.json(
        { error: `no route ${request.method} ${path}`, code: 'unknown_route', method: request.method, path },
        { status: 404 },
      );
    }
    if (request.method === 'GET') return Response.json(this.#snapshot());
    if (request.method === 'POST') {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      try {
        this.#apply(AgendaActionRequestSchema.parse(body));
      } catch (error) {
        return Response.json({ error: String(error), code: 'invalid' }, { status: 400 });
      }
      return Response.json(this.#snapshot());
    }
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }

  #apply(request: AgendaActionRequest): void {
    if (request.action === 'add') {
      this.#ordinal += 1;
      this.#items.push(
        AgendaItemSchema.parse({
          id: `A${this.#ordinal}`,
          source: request.source,
          sourceRef: request.sourceRef,
          subject: request.subject,
          why: request.why,
          context: request.context ?? null,
          waitingSince: EPOCH,
          howToResolve: request.howToResolve,
          ask: request.ask,
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.kind === undefined ? {} : { kind: request.kind }),
          ...(request.answers === undefined ? {} : { answers: request.answers }),
          ...agendaBriefOf(request),
          ...(request.notice === true ? { notice: true } : {}),
          ...(request.ping === true ? { ping: true } : {}),
          raisedBy: 'agent',
          raisedBySession: SESSION,
          raisedByName: null,
        }),
      );
      return;
    }

    if (request.action === 'log' || request.action === 'merge' || request.action === 'split') {
      const actor = { kind: 'agent' as const, sessionId: SESSION, name: null };
      const ledger: AgendaLedger = {
        sessionId: SESSION,
        nextId: this.#ordinal + 1,
        updatedAt: EPOCH,
        conversations: this.#conversations,
        entries: [
          ...this.#items.map(item => ({ lifecycle: 'active' as const, origin: actor, item })),
          ...this.#resolved.map(item => ({ lifecycle: 'addressed' as const, origin: actor, item })),
        ],
      };
      // This seam exercises shipped transitions behind the binary's HTTP/argv/schema path. No live daemon or tmux.
      const command =
        request.action === 'log'
          ? {
              action: 'log' as const,
              actor,
              at: EPOCH,
              id: request.id,
              mode: request.mode,
              words: request.text,
              chat: {
                messageId: request.messageId ?? 'owner-1',
                at: EPOCH,
                text: request.messageId === 'owner-2' ? 'Second owner message' : '    Use eu-west, please.\n',
              },
            }
          : request.action === 'merge'
            ? { action: 'merge' as const, actor, at: EPOCH, id: request.id, from: request.from }
            : {
                action: 'split' as const,
                actor,
                at: EPOCH,
                id: request.id,
                request: { source: 'agent-raised' as const, sourceRef: null, ...request.item },
                moveCards: request.moveCards,
              };
      const mutation = applyAgendaCommandToSession(ledger, SESSION, command);
      if (!mutation.ok) throw new Error(mutation.error.message);
      this.#conversations = mutation.ledger.conversations;
      this.#ordinal = mutation.ledger.nextId - 1;
      this.#items.splice(0, this.#items.length, ...mutation.snapshot.items);
      this.#resolved.splice(0, this.#resolved.length, ...mutation.snapshot.resolved);
      return;
    }

    if (
      request.action === 'edit' ||
      request.action === 'progress' ||
      request.action === 'surface' ||
      request.action === 'rest' ||
      request.action === 'snooze' ||
      request.action === 'unsnooze'
    ) {
      throw new Error(`the fake daemon does not ${request.action} items`);
    }
    const index = this.#items.findIndex(item => item.id === request.id);
    if (index === -1) throw new Error(`unknown agenda id ${request.id}`);
    const [item] = this.#items.splice(index, 1);
    this.#resolved.unshift(
      ResolvedAgendaItemSchema.parse({
        ...item,
        resolvedAt: EPOCH,
        resolutionNote: request.note ?? null,
        disposition: request.action === 'dismiss' ? 'dismissed' : 'done',
        resolvedBy: 'human',
        resolvedBySession: null,
        resolvedByName: null,
        ...(request.action === 'resolve' && request.response !== undefined ? { response: request.response } : {}),
      }),
    );
  }
}

let driver: CliDriver;
let daemon: FakeAgendaDaemon;

/**
 * Every new item a ferret raises must carry a premise and a context: an `add` here gets a stand-in for whichever
 * it does not name, so a journey about another flag reads as that flag alone. `bare` sends the words as typed.
 */
const withBrief = (args: readonly string[]): string[] =>
  args[0] !== 'add'
    ? [...args]
    : [
        ...args,
        ...(args.includes('--premise') ? [] : ['--premise', 'A ferret needs the owner.']),
        ...(args.includes('--context') ? [] : ['--context', 'The work waits on this answer.']),
      ];

function cli(args: string[], bare = false): Promise<CliResult> {
  return driver.run(['attention', ...(bare ? args : withBrief(args)), '--session', SESSION], {
    FY_URL: daemon.baseUrl,
    FY_TOKEN: 'sit-test-token',
    FY_SESSION_ID: SESSION,
  });
}

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakeAgendaDaemon();
});

afterAll(() => {
  daemon.stop();
});

describe(`attention lifecycle (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('carries a permission ask through raise, list, answer, and history', async () => {
    // Act
    const added = await cli(['add', 'approve the deploy', '--title', 'Deploy approval', '--kind', 'permission']);
    const listedAfterAdd = await cli(['ls']);
    const answered = await cli(['done', '!A1', '--approve']);
    const listedAfterAnswer = await cli(['ls']);
    const history = await cli(['history']);

    // Assert
    should(added.code).equal(0, added.err);
    should(added.out).containEql('!A1');
    should(listedAfterAdd.code).equal(0, listedAfterAdd.err);
    should(listedAfterAdd.out).containEql('!A1');
    should(answered.code).equal(0, answered.err);
    should(listedAfterAnswer.code).equal(0, listedAfterAnswer.err);
    should(listedAfterAnswer.out).not.containEql('!A1'); // resolved leaves the active view immediately
    should(history.code).equal(0, history.err);
    should(history.out).containEql('!A1');
    should(history.out).containEql('approved'); // the exact typed response, not just "resolved"
  });

  it('carries a multiple-choice ask through raise, list, answer, and history', async () => {
    // Act
    const added = await cli([
      'add',
      'pick a cluster',
      '--title',
      'Cluster',
      '--kind',
      'choice',
      '--option',
      'staging',
      '--option',
      'prod',
    ]);
    const listedAfterAdd = await cli(['ls']);
    const answered = await cli(['done', '!A2', '--choice', 'staging']);
    const listedAfterAnswer = await cli(['ls']);
    const history = await cli(['history']);

    // Assert
    should(added.code).equal(0, added.err);
    should(listedAfterAdd.out).containEql('!A2');
    should(answered.code).equal(0, answered.err);
    should(listedAfterAnswer.out).not.containEql('!A2');
    should(history.out).containEql('!A2');
    should(history.out).containEql('chose "staging"');
  });

  it('carries an answer-review ask through raise, list, answer, and history', async () => {
    // Act
    const added = await cli(['add', 'review the migration plan', '--title', 'Migration plan', '--kind', 'review']);
    const listedAfterAdd = await cli(['ls']);
    const answered = await cli(['done', '!A3', '--clarify', 'which table does this touch?']);
    const listedAfterAnswer = await cli(['ls']);
    const history = await cli(['history']);

    // Assert
    should(added.code).equal(0, added.err);
    should(listedAfterAdd.out).containEql('!A3');
    should(answered.code).equal(0, answered.err);
    should(listedAfterAnswer.out).not.containEql('!A3');
    should(history.out).containEql('!A3');
    should(history.out).containEql('clarification requested: which table does this touch?');
  });

  it('carries an open-question ask through raise, list, dismiss, and history', async () => {
    // Act — dismissed rather than answered, to exercise the other clearing path across every kind.
    const added = await cli(['add', 'name the release', '--title', 'Release name', '--kind', 'open']);
    const listedAfterAdd = await cli(['ls']);
    const dismissed = await cli(['dismiss', '!A4', '--note', 'superseded by the next release']);
    const listedAfterDismiss = await cli(['ls']);
    const history = await cli(['history']);

    // Assert
    should(added.code).equal(0, added.err);
    should(listedAfterAdd.out).containEql('!A4');
    should(dismissed.code).equal(0, dismissed.err);
    should(listedAfterDismiss.out).not.containEql('!A4');
    should(history.out).containEql('!A4');
    should(history.out).containEql('dismissed by human');
    should(history.out).containEql('superseded by the next release');
  });

  it('raises a structured item from a JSON body, flags winning, and lists every part of it', async () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'fy-agenda-sit-'));
    const body = join(directory, 'brief.json');
    writeFileSync(
      body,
      JSON.stringify({
        title: 'Work login plan',
        summary: 'Approve the OCI work-login plan',
        context: 'The work login expires every day.',
        terms: [{ term: 'OCI', meaning: 'Oracle Cloud Infrastructure' }],
        questions: [{ question: 'Which plan?', options: ['Defaults', 'Changes'], recommended: 'Defaults' }],
        impact: 'You stay logged out',
      }),
    );

    try {
      // Act
      const added = await cli([
        'add',
        '--json-file',
        body,
        '--urgency',
        'today',
        '--link',
        '#F12',
        '--link',
        'Plan=&F9=The plan to keep the login alive',
      ]);
      const listed = await cli(['ls']);

      // Assert
      should(added.code).equal(0, added.err);
      should(added.out).containEql('agenda !A5 recorded');
      should(listed.out).containEql('Approve the OCI work-login plan');
      should(listed.out).containEql('Work login plan');
      should(listed.out).containEql('answers: ← Defaults · → Changes');
      should(listed.out).containEql('recommended: Defaults');
      should(listed.out).containEql('impact: You stay logged out — by today');
      should(listed.out).containEql('terms: OCI = Oracle Cloud Infrastructure');
      should(listed.out).containEql('links: #F12 · Plan (The plan to keep the login alive)');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('names the field a limit refused, before anything is sent', async () => {
    // Act
    const refused = await cli(['add', 'too urgent', '--title', 'Urgent', '--urgency', 'u'.repeat(200)]);

    // Assert
    should(refused.code).not.equal(0);
    should(refused.err).containEql('urgency');
  });

  it('refuses a card with no premise or no context before anything is sent, naming the flags', async () => {
    // Act
    const neither = await cli(['add', 'approve the deploy', '--title', 'Deploy'], true);
    const noContext = await cli(
      ['add', 'approve the deploy', '--title', 'Deploy', '--premise', 'A deploy waits'],
      true,
    );
    const listed = await cli(['ls']);

    // Assert
    should(neither.code).not.equal(0);
    should(neither.err).containEql('agenda add needs --premise and --context');
    should(noContext.code).not.equal(0);
    should(noContext.err).containEql('agenda add needs --context');
    should(listed.out).not.containEql('approve the deploy');
  });

  it('refuses a card with no title before anything is sent', async () => {
    // Act
    const refused = await cli(['add', 'approve the deploy']);

    // Assert
    should(refused.code).not.equal(0);
    should(refused.err).containEql('give the card a title: --title');
  });

  it('lists the open agenda before opening another, then opens it with --new "<why none fits>"', async () => {
    // Act — !A5 is still open: search, check, then open.
    const refused = await cli(['add', 'Ship the release now?', '--title', 'Release', '--kind', 'yesno']);
    const listed = await cli(['ls']);

    // Assert — a ferret (nobody at the terminal) is refused with the candidates and the way out; a yes or no cannot be
    // squeezed into !A5, so no edit is offered and nothing is opened.
    should(refused.code).not.equal(0);
    should(refused.err).containEql('Search, check, then open: these agendas are open, closest first.');
    should(refused.err).containEql('!A5  needs you  Work login plan');
    should(refused.err).containEql('Should this join !A5?');
    should(refused.err).containEql('which an agenda edit cannot add');
    should(refused.err).not.containEql('fy agenda edit A5');
    should(refused.err).containEql('--new "<why none fits; closest is !A5>"');
    should(listed.out).not.containEql('!A6');
  });

  it('lists a titled yes or no card as a heading, the ask and its swipe answers, and answers it with --yes', async () => {
    // Act
    const added = await cli([
      'add',
      'Ship the release now?',
      '--title',
      'Release',
      '--kind',
      'yesno',
      '--new',
      'the release is its own decision',
    ]);
    const listed = await cli(['ls']);
    const answered = await cli(['done', '!A6', '--yes']);
    const history = await cli(['history']);

    // Assert
    should(added.code).equal(0, added.err);
    should(listed.out).containEql('!A6  [agent-raised]  Release');
    should(listed.out).containEql('ask: Ship the release now?');
    should(listed.out).containEql('answers: ← No · → Yes');
    should(answered.code).equal(0, answered.err);
    should(history.out).containEql('chose "Yes"');
  });

  it('refuses more than three options with the advice to split the item', async () => {
    // Act
    const refused = await cli(['add', 'which', '--title', 'Which', '-o', 'a', '-o', 'b', '-o', 'c', '-o', 'd']);

    // Assert
    should(refused.code).not.equal(0);
    should(refused.err).containEql('a card offers at most 3 answers');
  });

  it('sends a plain notification through the deprecated alias, and pings only when asked', async () => {
    // Act
    const notified = await cli(['notify', 'the build is green']);
    const pinged = await cli(['notify', 'the deploy needs your login', '--ping']);
    const listed = await cli(['ls']);
    const retired = await cli(['notify', 'the build is green', '--title', 'CI']);

    // Assert
    should(notified.code).equal(0, notified.err);
    should(notified.out).containEql('Sent.');
    should(pinged.code).equal(0, pinged.err);
    should(pinged.out).containEql('their phone buzzes');
    should(listed.out).containEql('!A7');
    should(listed.out).containEql('notice: read, not answered');
    should(listed.out).containEql('notice: read, not answered (pinged)');
    should(retired.code).not.equal(0);
    should(retired.err).containEql("unknown option '--title'");
  });

  it('lists a card agenda that carries a card ask as one agenda, read through the wire contract (docs/agenda.md § Card asks)', async () => {
    // Arrange — the daemon opened ONE agenda for a card at its gate, carrying the ask with its How to test
    daemon.seed(
      AgendaItemSchema.parse({
        id: 'A90',
        source: 'task',
        sourceRef: 'card-agenda:F412',
        subject: 'Try it: open the Board',
        why: '&F412 reached Released.',
        waitingSince: EPOCH,
        howToResolve: 'Answer the card’s ask here (its buttons move the card); reply to talk it over.',
        ask: { kind: 'open-question' },
        kind: 'reply',
        title: 'Badge fix',
        task: { id: 'F412' },
        stage: 'test',
        cardAsks: [
          {
            gate: {
              cardId: 'F412',
              laneId: 'released',
              laneName: 'Released',
              entry: 2,
              projectId: 'p-1',
              options: [
                { id: 'done', label: 'Done', outcome: 'close' },
                { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
              ],
            },
            at: EPOCH,
            howToTest: '1. Open the Board\n2. Look for the badge',
          },
        ],
        raisedBy: 'daemon',
        raisedBySession: null,
        raisedByName: null,
      }),
    );

    // Act
    const listed = await cli(['ls']);

    // Assert — the real CLI parsed the card ask and lists the agenda, never a separate gate item
    should(listed.code).equal(0, listed.err);
    should(listed.out).containEql('!A90');
    should(listed.out).containEql('Badge fix');
  });
});

describe('agenda conversation verbs (SIT)', () => {
  it('logs exact words and repeated replies, refuses duplicates, merges and splits through the CLI', async () => {
    const server = new FakeAgendaDaemon();
    const run = (args: string[]) =>
      driver.run(['agenda', ...args, '--session', SESSION], {
        FY_URL: server.baseUrl,
        FY_TOKEN: 'sit-test-token',
        FY_SESSION_ID: SESSION,
      });
    try {
      const add = (ask: string) =>
        run([
          'add',
          ask,
          '--title',
          ask,
          '--premise',
          'A release is ready.',
          '--context',
          'The deploy needs a region.',
          '--new',
          'This decision has its own rollout schedule.',
        ]);
      for (const ask of ['Which region?', 'Which quota?']) {
        const result = await add(ask);
        should(result.code).equal(0, result.err);
      }
      for (const message of ['owner-1', 'owner-2']) {
        const result = await run(['log', 'A1', '--reply', 'OK', '--message', message]);
        should(result.code).equal(0, result.err);
      }
      const duplicate = await run(['log', 'A1', '--reply', 'OK', '--message', 'owner-1']);
      should(duplicate.code).not.equal(0);
      should(duplicate.err).containEql('already');
      const logged = await run(['ls', '--json']);
      should(logged.code).equal(0, logged.err);
      should(logged.out).containEql('    Use eu-west, please.\\n');
      should(logged.out.match(/"text":\s*"OK"/gu) ?? []).have.length(2);
      const merged = await run(['merge', 'A1', 'A2']);
      should(merged.code).equal(0, merged.err);
      const split = await run([
        'split',
        'A1',
        'Which cache?',
        '--title',
        'Cache',
        '--premise',
        'A cache is needed.',
        '--context',
        'Cache rollout has its own schedule.',
      ]);
      should(split.code).equal(0, split.err);
      should(split.out).containEql('!A3');
      const listed = await run(['ls', '--json']);
      should(listed.code).equal(0, listed.err);
      should(listed.out).containEql('splitInto');
      should(listed.out).containEql('splitFrom');
      const history = await run(['history', '--json']);
      should(history.code).equal(0, history.err);
      should(history.out).containEql('mergedInto');
    } finally {
      server.stop();
    }
  });
});
