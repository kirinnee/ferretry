import { afterAll, beforeAll, describe, it } from 'bun:test';
import {
  ATTENTION_SCHEMA_VERSION,
  type AttentionActionRequest,
  AttentionActionRequestSchema,
  type AttentionItem,
  AttentionItemSchema,
  type AttentionSnapshot,
  type ResolvedAttentionItem,
  ResolvedAttentionItemSchema,
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

const SESSION = 'sit-attention-session';
const EPOCH = new Date(0).toISOString();

/**
 * A minimal stand-in for `fyd`'s attention route, not `fyd` itself.
 *
 * WHAT THIS PROVES: a real compiled `fy` binary, over a real HTTP round trip (retries, headers,
 * timeouts, schema parsing all included), driving the whole CLI-visible lifecycle a human cares
 * about — raise, active listing, answer/dismiss, immediate absence, and a history entry carrying the
 * exact typed response — across all four ask kinds. Every item this server hands back is constructed
 * through `AttentionItemSchema`/`ResolvedAttentionItemSchema`, so a mismatch with the real wire
 * contract fails here too, not just in the CLI's own unit tests.
 *
 * WHAT THIS DOES NOT PROVE: anything inside the real daemon. `applyToLedger()`, its authorization
 * predicates, and the session-registry check the real route makes before it will even look at a
 * board (`AttentionSessionDirectory.has`, backed by the live session registry in
 * `packages/daemon/bin/fyd.ts`) belong to `packages/daemon/tests/unit/attention/{service,
 * state-machine}.test.ts`. This repo's SIT tier is deliberately CLI-only and black-box — no SIT
 * journey anywhere spawns a live `fyd` — so this doubles the daemon at exactly the seam the CLI's own
 * transport speaks, the same way `tests/integration/tasks/fake-daemon.ts`'s `FakeTransport` does one
 * layer further in.
 */
class FakeAttentionDaemon {
  readonly #items: AttentionItem[] = [];
  readonly #resolved: ResolvedAttentionItem[] = [];
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

  #snapshot(): AttentionSnapshot {
    return {
      v: ATTENTION_SCHEMA_VERSION,
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
    if (path !== `/v1/sessions/${encodeURIComponent(SESSION)}/attention`) {
      return Response.json({ error: 'unknown route' }, { status: 404 });
    }
    if (request.method === 'GET') return Response.json(this.#snapshot());
    if (request.method === 'POST') {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      this.#apply(AttentionActionRequestSchema.parse(body));
      return Response.json(this.#snapshot());
    }
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }

  #apply(request: AttentionActionRequest): void {
    if (request.action === 'add') {
      this.#ordinal += 1;
      this.#items.push(
        AttentionItemSchema.parse({
          id: `A${this.#ordinal}`,
          source: request.source,
          sourceRef: request.sourceRef,
          subject: request.subject,
          why: request.why,
          context: request.context ?? null,
          waitingSince: EPOCH,
          howToResolve: request.howToResolve,
          ask: request.ask,
          raisedBy: 'agent',
          raisedBySession: SESSION,
          raisedByName: null,
        }),
      );
      return;
    }

    const index = this.#items.findIndex(item => item.id === request.id);
    if (index === -1) throw new Error(`unknown attention id ${request.id}`);
    const [item] = this.#items.splice(index, 1);
    this.#resolved.unshift(
      ResolvedAttentionItemSchema.parse({
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
let daemon: FakeAttentionDaemon;

function cli(args: string[]): Promise<CliResult> {
  return driver.run(['attention', ...args, '--session', SESSION], {
    FY_URL: daemon.baseUrl,
    FY_TOKEN: 'sit-test-token',
    FY_SESSION_ID: SESSION,
  });
}

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakeAttentionDaemon();
});

afterAll(() => {
  daemon.stop();
});

describe(`attention lifecycle (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('carries a permission ask through raise, list, answer, and history', async () => {
    // Act
    const added = await cli(['add', 'approve the deploy', '--kind', 'permission']);
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
    const added = await cli(['add', 'pick a cluster', '--kind', 'choice', '--option', 'staging', '--option', 'prod']);
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
    const added = await cli(['add', 'review the migration plan', '--kind', 'review']);
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
    const added = await cli(['add', 'name the release', '--kind', 'open']);
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
});
