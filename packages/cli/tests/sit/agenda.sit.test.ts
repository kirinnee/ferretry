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
  type ResolvedAgendaItem,
  ResolvedAgendaItemSchema,
} from '@ferretry/protocol';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
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
 * transport speaks, the same way `tests/integration/tasks/fake-daemon.ts`'s `FakeTransport` does one
 * layer further in.
 */
class FakeAgendaDaemon {
  readonly #items: AgendaItem[] = [];
  readonly #resolved: ResolvedAgendaItem[] = [];
  #ordinal = 0;
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
    // A daemon of this build answers the agenda spelling and the older attention one alike
    // (docs/agenda.md § Compatibility), and refuses anything else the way the real one does.
    if (path !== `${session}/agenda` && path !== `${session}/attention`) {
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
      this.#apply(AgendaActionRequestSchema.parse(body));
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

    if (request.action === 'edit' || request.action === 'progress' || request.action === 'surface') {
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

function cli(args: string[]): Promise<CliResult> {
  return driver.run(['attention', ...args, '--session', SESSION], {
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
      const added = await cli(['add', '--json-file', body, '--urgency', 'today', '--link', '#F12']);
      const listed = await cli(['ls']);

      // Assert
      should(added.code).equal(0, added.err);
      should(added.out).containEql('agenda !A5 recorded');
      should(listed.out).containEql('Approve the OCI work-login plan');
      should(listed.out).containEql('Work login plan');
      should(listed.out).containEql('answers: ← Changes · → Defaults');
      should(listed.out).containEql('recommended: Defaults');
      should(listed.out).containEql('impact: You stay logged out — by today');
      should(listed.out).containEql('terms: OCI = Oracle Cloud Infrastructure');
      should(listed.out).containEql('links: #F12');
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

  it('refuses a card with no title before anything is sent', async () => {
    // Act
    const refused = await cli(['add', 'approve the deploy']);

    // Assert
    should(refused.code).not.equal(0);
    should(refused.err).containEql('give the card a title: --title');
  });

  it('lists a titled yes or no card as a heading, the ask and its swipe answers, and answers it with --yes', async () => {
    // Act
    const added = await cli(['add', 'Ship the release now?', '--title', 'Release', '--kind', 'yesno']);
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
});
