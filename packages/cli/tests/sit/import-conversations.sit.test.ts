/**
 * `fy import conversations` and `fy new --continue` through the real composition root.
 *
 * Drives a small fake daemon that answers the conversation-import routes from fixtures, parsing
 * every request through the shared protocol schema the real daemon uses — proving the shipped
 * wiring (bin/fy.ts) hands the commands a gateway that speaks the real routes, not just that the
 * unit-tested controllers do the right thing against a recording double.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import {
  type ConversationAdoptRequest,
  ConversationAdoptRequestSchema,
  type ImportableConversation,
} from '@ferretry/protocol';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const NOW = Date.now();
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

const FRESH_CLAUDE = 'aaaaaaaa-0000-4000-8000-000000000001';
const STALE_CODEX = 'aaaaaaaa-0000-4000-8000-000000000002';
const ALREADY_ADOPTED = 'aaaaaaaa-0000-4000-8000-000000000003';

const CONVERSATIONS: readonly ImportableConversation[] = [
  {
    id: FRESH_CLAUDE,
    harness: 'claude',
    project: '/work/app',
    preview: 'Fix the login page',
    lastActivityAt: daysAgo(1),
    turns: 3,
    model: 'claude-sonnet-4-5',
  },
  {
    id: STALE_CODEX,
    harness: 'codex',
    project: '/work/app',
    preview: 'Refactor the build script',
    lastActivityAt: daysAgo(40),
    turns: 1,
  },
  {
    id: ALREADY_ADOPTED,
    harness: 'claude',
    project: '/work/other',
    preview: 'Add tests',
    lastActivityAt: daysAgo(2),
    turns: 5,
    adoptedBy: 's-existing',
  },
];

/** Answers the two conversation-import routes from the fixtures above, filtering a listing query the way the real daemon's index does. */
class FakeImportDaemon {
  readonly adoptRequests: ConversationAdoptRequest[] = [];
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

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /v1/imports/conversations':
        return Response.json(this.#listing(url.searchParams));
      case 'POST /v1/imports/conversations/adopt': {
        const body = ConversationAdoptRequestSchema.parse(await request.json());
        this.adoptRequests.push(body);
        return Response.json(this.#adopt(body));
      }
      default:
        return Response.json({ error: `unknown route ${route}` }, { status: 404 });
    }
  }

  #listing(params: URLSearchParams) {
    const harness = params.get('harness');
    const q = params.get('q')?.toLowerCase();
    const since = params.get('since');
    const limit = params.get('limit');
    const matched = CONVERSATIONS.filter(
      row =>
        (harness === null || row.harness === harness) &&
        (q === undefined || q === '' || `${row.preview} ${row.project}`.toLowerCase().includes(q)) &&
        (since === null || row.lastActivityAt >= since),
    );
    const bounded = limit === null ? matched : matched.slice(0, Number(limit));
    return { conversations: bounded, matched: matched.length, skipped: 0 };
  }

  #adopt(request: ConversationAdoptRequest) {
    const adopted = [];
    const refused = [];
    for (const item of request.conversations) {
      const row = CONVERSATIONS.find(candidate => candidate.id === item.id);
      if (row === undefined) {
        refused.push({ id: item.id, code: 'not_found' as const, reason: 'unknown to this fake daemon' });
      } else {
        adopted.push({
          id: item.id,
          session: `s-${item.id.slice(-4)}`,
          name: 'Imported',
          status: item.start ? 'running' : 'created',
        });
      }
    }
    return { adopted, refused };
  }
}

let driver: CliDriver;
let daemon: FakeImportDaemon;

const cli = (args: string[]): Promise<CliResult> =>
  driver.run(args, { FY_URL: daemon.baseUrl, FY_TOKEN: 'sit-test-token', FY_SESSION_ID: '' });

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakeImportDaemon();
});

afterAll(() => {
  daemon.stop();
});

describe(`import conversations (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should list every conversation, grouped by project, with the already-adopted one marked', async () => {
    // Act
    const listed = await cli(['import', 'conversations']);

    // Assert
    should(listed.code).equal(0, listed.err);
    should(listed.out).containEql('/work/app:');
    should(listed.out).containEql('/work/other:');
    should(listed.out).containEql(FRESH_CLAUDE);
    should(listed.out).containEql('kept as s-existing');
  });

  it('should narrow by --since on the daemon, excluding the stale conversation', async () => {
    // Act
    const recent = await cli(['import', 'conversations', '--since', '30d']);

    // Assert
    should(recent.code).equal(0, recent.err);
    should(recent.out).not.containEql(STALE_CODEX);
    should(recent.out).containEql(FRESH_CLAUDE);
  });

  it('should adopt a selected conversation and start it', async () => {
    // Act
    const adopted = await cli([
      'import',
      'conversations',
      '--select',
      FRESH_CLAUDE,
      '--runtime',
      'claude-work',
      '--start',
    ]);

    // Assert
    should(adopted.code).equal(0, adopted.err);
    should(adopted.out).containEql('adopted');
    should(adopted.out).containEql('Imported');
    should(daemon.adoptRequests.at(-1)).eql({
      harness: 'claude',
      runtime: 'claude-work',
      conversations: [{ id: FRESH_CLAUDE, start: true }],
    });
  });

  it('should refuse more than ten starts before ever dialing the daemon', async () => {
    // Arrange
    const requestsBefore = daemon.adoptRequests.length;
    const ids = Array.from(
      { length: 11 },
      (_, index) => `aaaaaaaa-0000-4000-8000-0000000000${index.toString().padStart(2, '0')}`,
    );

    // Act
    const refused = await cli(['import', 'conversations', '--select', ...ids, '--runtime', 'claude-work', '--start']);

    // Assert
    should(refused.code).equal(1);
    should(refused.err).containEql('at most 10');
    should(daemon.adoptRequests.length).equal(requestsBefore);
  });

  it('`fy new` without --continue should say to use `fy start`, and refuse', async () => {
    // Act
    const result = await cli(['new']);

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql(`${binaryName} start`);
  });

  it('`fy new --continue` should open the one conversation it finds with a unique query', async () => {
    // Act
    const result = await cli(['new', '--continue', 'login', 'page', '--runtime', 'claude-work']);

    // Assert
    should(result.code).equal(0, result.err);
    should(result.out).containEql('attach');
    should(daemon.adoptRequests.at(-1)).eql({
      harness: 'claude',
      runtime: 'claude-work',
      conversations: [{ id: FRESH_CLAUDE, start: true }],
    });
  });

  it('`fy new --continue` should open the already-adopted match without adopting it again', async () => {
    // Arrange
    const requestsBefore = daemon.adoptRequests.length;

    // Act
    const result = await cli(['new', '--continue', 'add', 'tests']);

    // Assert
    should(result.code).equal(0, result.err);
    should(result.out).containEql('already kept as s-existing');
    should(daemon.adoptRequests.length).equal(requestsBefore);
  });

  it('`fy new --continue` should refuse several matches non-interactively (no driver ever runs with a TTY here)', async () => {
    // Act
    const result = await cli(['new', '--continue', '--runtime', 'claude-work']);

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('narrow the search');
  });
});
