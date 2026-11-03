import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoardTaskActionRequestSchema,
  BoardTaskCreateRequestSchema,
  type BoardTaskView,
  BoardTaskViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { card as cardFixture, FERRETRY_ID, listing } from '../integration/board/fixtures';
import { laneSet } from '../integration/board-lanes/fixtures';
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

const FERRET = 'sit-card-ferret';
const OWNER_ASK = ['--ask', 'please show the board by default', '--ask-source', 'owner (board)'];
const FERRET_ASK = ['--ask', 'a helper idea', '--ask-source', `session:${FERRET}`];

/**
 * A minimal stand-in for `fyd`'s board routes, not `fyd` itself.
 *
 * WHAT THIS PROVES: the real `fy` (compiled binary or in-process), over a real HTTP round trip, sends the
 * visibility flags as the wire fields the daemon reads, asks the board for public cards unless told otherwise,
 * sends `--private` and `--all` as the filters they name, and sends a combined `task edit` as ONE request whose one
 * JSON result is printed — and prints a refusal without anything having been applied. Every card this server hands
 * back is built through `BoardTaskViewSchema`, so a mismatch with the wire contract fails here too.
 *
 * WHAT THIS DOES NOT PROVE: who may hide what. That is the daemon's rule (`packages/daemon/tests/unit/board/
 * visibility.test.ts`); this double applies a stand-in of it at the same seam so the CLI's side of a refusal can be
 * seen. No SIT journey spawns a live `fyd`.
 */
class FakeBoardDaemon {
  readonly cards: BoardTaskView[] = [];
  readonly queries: string[] = [];
  readonly posts: { readonly path: string; readonly body: unknown; readonly session: string | null }[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;
  #ordinal = 0;

  constructor() {
    this.#server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => this.#handle(request) });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  stop(): void {
    this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/v1/sessions') return Response.json([]);
    if (path === '/v1/board/projects') return Response.json(listing({ current: FERRETRY_ID as never }));
    if (path === '/v1/board' && request.method === 'GET') {
      this.queries.push(url.searchParams.get('visibility') ?? '');
      const wanted = url.searchParams.get('visibility');
      const shown = this.cards.filter(task => wanted === null || task.visibility === wanted);
      return Response.json({
        projectId: FERRETRY_ID,
        laneSet: laneSet(),
        cards: shown,
        counts: { closedHidden: 0, stale: 0, orphaned: 0, active: shown.length, toTest: 0, waitingOnYou: 0 },
        nextCursor: null,
        quarantined: [],
      });
    }
    if (request.method !== 'POST') return Response.json({ error: 'not here', code: 'not_found' }, { status: 404 });
    const body: unknown = await request.json();
    const session = request.headers.get('x-ferretry-session-id');
    this.posts.push({ path, body, session });
    if (path === '/v1/board/tasks') return this.#create(BoardTaskCreateRequestSchema.parse(body), session);
    const found = this.cards.find(task => path === `/v1/board/tasks/${task.id}`);
    if (found === undefined) return Response.json({ error: 'no such card', code: 'not_found' }, { status: 404 });
    return this.#act(found, BoardTaskActionRequestSchema.parse(body), session);
  }

  /** The stand-in rule: a ferret may never hide a card the owner asked for. */
  #refuses(task: { readonly ask: { readonly source: string } }, to: string, session: string | null): boolean {
    return session !== null && task.ask.source.startsWith('owner') && to === 'private';
  }

  #create(request: ReturnType<typeof BoardTaskCreateRequestSchema.parse>, session: string | null): Response {
    const byOwner = request.ask.source.startsWith('owner');
    const visibility = request.visibility ?? (byOwner ? 'public' : 'private');
    if (this.#refuses(request, visibility, session) && request.visibility !== undefined) {
      return Response.json(
        { error: 'only the owner may make a card they asked for private', code: 'forbidden', allowed: ['owner-human'] },
        { status: 403 },
      );
    }
    this.#ordinal += 1;
    const created = BoardTaskViewSchema.parse(
      cardFixture({
        id: `F${this.#ordinal}` as never,
        title: request.title,
        ask: request.ask,
        visibility,
      }),
    );
    this.cards.push(created);
    return Response.json({ task: created, laneSet: laneSet() });
  }

  #act(found: BoardTaskView, request: ReturnType<typeof BoardTaskActionRequestSchema.parse>, session: string | null) {
    if (request.action !== 'edit')
      return Response.json({ error: 'not in this double', code: 'invalid' }, { status: 400 });
    if (request.visibility !== undefined && this.#refuses(found, request.visibility, session)) {
      return Response.json(
        { error: 'only the owner may make a card they asked for private', code: 'forbidden', allowed: ['owner-human'] },
        { status: 403 },
      );
    }
    const index = this.cards.findIndex(task => task.id === found.id);
    const edited = BoardTaskViewSchema.parse({
      ...found,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.visibility === undefined ? {} : { visibility: request.visibility }),
    });
    this.cards[index] = edited;
    return Response.json({ task: edited, laneSet: laneSet() });
  }
}

let driver: CliDriver;
let daemon: FakeBoardDaemon;
let home: string;

/** `as` is the acting ferret; without one the daemon reads the caller as the owner. */
function cli(args: string[], as: string | null = FERRET): Promise<CliResult> {
  return driver.run(args, {
    FY_URL: daemon.baseUrl,
    FY_TOKEN: 'sit-test-token',
    FY_HOME: home,
    FY_SESSION_ID: as ?? '',
  });
}

const ids = (result: CliResult): string[] =>
  (JSON.parse(result.out) as { cards: { id: string }[] }).cards.map(task => task.id).toSorted();

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakeBoardDaemon();
  home = mkdtempSync(join(tmpdir(), 'fy-card-visibility-sit-'));
});

afterAll(() => {
  daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

describe(`card visibility (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('creates a public, a private and a defaulted card, and lists them by the filter asked for', async () => {
    // Act
    const publicCard = await cli([
      'task',
      'create',
      '--kind',
      'feature',
      '--title',
      'Public one',
      '--public',
      ...FERRET_ASK,
      '--json',
    ]);
    const privateCard = await cli(
      ['task', 'create', '--kind', 'feature', '--title', 'Private one', '--private', ...OWNER_ASK, '--json'],
      null,
    );
    const defaulted = await cli([
      'task',
      'create',
      '--kind',
      'feature',
      '--title',
      'Defaulted one',
      ...FERRET_ASK,
      '--json',
    ]);
    const byDefault = await cli(['board', '--json']);
    const onlyPrivate = await cli(['board', '--private', '--json']);
    const everything = await cli(['board', '--all', '--json']);

    // Assert
    should(publicCard.code).equal(0, publicCard.err);
    should(JSON.parse(publicCard.out)).have.property('task').match({ id: 'F1', visibility: 'public' });
    should(privateCard.code).equal(0, privateCard.err);
    should(JSON.parse(privateCard.out)).have.property('task').match({ id: 'F2', visibility: 'private' });
    should(defaulted.code).equal(0, defaulted.err);
    should(JSON.parse(defaulted.out)).have.property('task').match({ id: 'F3', visibility: 'private' });
    should(byDefault.code).equal(0, byDefault.err);
    should(ids(byDefault)).eql(['F1']);
    should(ids(onlyPrivate)).eql(['F2', 'F3']);
    should(ids(everything)).eql(['F1', 'F2', 'F3']);
    should(daemon.queries).eql(['public', 'private', '']);
  });

  it('sends the visibility flags as the fields the daemon reads', () => {
    // Assert
    const sent = daemon.posts
      .filter(post => post.path === '/v1/board/tasks')
      .map(post => (post.body as { visibility?: string }).visibility);
    should(sent).eql(['public', 'private', undefined]);
  });

  it('applies a combined edit as one request and prints one JSON result', async () => {
    // Arrange
    const before = daemon.posts.length;

    // Act
    const edited = await cli([
      'task',
      'edit',
      'F3',
      '--title',
      'Renamed and shown',
      '--visibility',
      'public',
      '--json',
    ]);

    // Assert
    should(edited.code).equal(0, edited.err);
    should(daemon.posts.length - before).equal(1);
    should(daemon.posts.at(-1)?.body).match({ action: 'edit', title: 'Renamed and shown', visibility: 'public' });
    const result = JSON.parse(edited.out) as { task: BoardTaskView };
    should(result.task).match({ id: 'F3', title: 'Renamed and shown', visibility: 'public' });
    should(ids(await cli(['board', '--json']))).eql(['F1', 'F3']);
  });

  it('refuses a ferret hiding the owner’s ask and applies none of the edit', async () => {
    // Act
    const refused = await cli(
      ['task', 'edit', 'F2', '--title', 'Hidden by a ferret', '--visibility', 'private', '--json'],
      FERRET,
    );
    const ownerOwn = await cli(
      ['task', 'create', '--kind', 'feature', '--title', 'Mine', '--public', ...OWNER_ASK, '--json'],
      null,
    );
    const refusedCreate = await cli(
      ['task', 'create', '--kind', 'feature', '--title', 'Hide it', '--private', ...OWNER_ASK, '--json'],
      FERRET,
    );

    // Assert
    should(refused.code).not.equal(0);
    should(refused.out).not.containEql('"task"');
    should(refused.err.length).be.above(0);
    should(daemon.cards.find(task => task.id === 'F2')?.title).equal('Private one');
    should(ownerOwn.code).equal(0, ownerOwn.err);
    should(refusedCreate.code).not.equal(0);
    should(daemon.cards.map(task => task.title)).not.containEql('Hide it');
  });

  it('refuses a visibility that is neither public nor private before any request', async () => {
    // Arrange
    const before = daemon.posts.length;

    // Act
    const refused = await cli(['task', 'edit', 'F1', '--title', 'Nope', '--visibility', 'secret']);

    // Assert
    should(refused.code).not.equal(0);
    should(daemon.posts.length).equal(before);
  });
});
