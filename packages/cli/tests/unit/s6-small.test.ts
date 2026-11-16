/**
 * Sweep s6's small parity rows, each through the shell's REAL verb table and the REAL plugin halves over a fake daemon:
 * a bare `fy catalog` / `fy member` (V-0161, V-0321), `fy login budget nope` (V-0211, F6) and `fy lesson suggest` without
 * `--scope` (V-0308).
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

class RoutedTransport extends RecordingTransport {
  constructor(private readonly answers: Record<string, DaemonReply>) {
    super();
  }
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    return (
      this.answers[`${request.method} ${request.path.split('?')[0] as string}`] ?? {
        status: 404,
        body: { error: 'nothing here' },
      }
    );
  }
}

const PUBLISHER = `fy_daemon_${'P'.repeat(43)}`;

const world = (answers: Record<string, DaemonReply>, environment: Record<string, string> = {}) => {
  const transport = new RoutedTransport(answers);
  const made = fakeWorld({
    registry,
    inventory: {
      protocol: 'x' as never,
      plugins: [
        { id: 'kernel', on: true, contract: registry.kernel.contract },
        ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
      ],
    },
    transport,
    environment,
  });
  return { ...made, transport };
};

const CATALOGS = { 'GET /v1/catalogs': { status: 200, body: { publisher: PUBLISHER, catalogs: [] } } } as const;
const MEMBERS = { 'GET /v1/catalog-members': { status: 200, body: { members: [] } } } as const;

describe('a bare group runs its default sub-verb (V-0161, V-0321)', () => {
  it('V-0161 should list the catalogs for a bare `fy catalog`, exactly as `fy catalog ls` does', async () => {
    const bare = world({ ...CATALOGS });
    const named = world({ ...CATALOGS });
    const code = await runFy(['catalog'], bare.world);
    const sameCode = await runFy(['catalog', 'ls'], named.world);
    should(bare.io.stderr()).equal('');
    should(code).equal(0);
    should(sameCode).equal(0);
    should(bare.io.stdout()).equal(named.io.stdout());
    should(bare.transport.sent.map(request => `${request.method} ${request.path}`)).deepEqual(
      named.transport.sent.map(request => `${request.method} ${request.path}`),
    );
    should(bare.transport.sent.length).be.above(0);
  });

  it('V-0161 should pass `--json` through a bare `fy catalog`', async () => {
    const { world: w, io } = world({ ...CATALOGS });
    should(await runFy(['catalog', '--json'], w)).equal(0);
    should(JSON.parse(io.stdout())).have.property('catalogs');
  });

  it('V-0321 should say who has joined for a bare `fy member` (v4: "Nobody has joined yet…")', async () => {
    const { world: w, io } = world({ ...MEMBERS, ...CATALOGS });
    should(await runFy(['member'], w)).equal(0);
    should(io.stdout()).containEql('Nobody has joined yet');
  });

  it('should still refuse an unknown sub-verb of either group with exit 2, before any daemon call', async () => {
    for (const words of [
      ['catalog', 'frobnicate'],
      ['member', '--json', 'frobnicate'],
    ]) {
      const { world: w, io, transport } = world({});
      should(await runFy(words, w)).equal(2);
      should(io.stderr()).containEql('is not a sub-verb of');
      should(transport.sent).deepEqual([]);
    }
  });
});

describe('fy login budget <login> (V-0211, F6)', () => {
  const LOGINS = {
    'GET /v1/logins': { status: 200, body: { format: 1, machine: 'laptop', logins: [{ id: 'claude-a' }] } },
  };
  const FILE = {
    'GET /v1/config/file': { status: 200, body: { path: 'usage.yaml', exists: false, text: '', etag: 'e' } },
  };
  const BUDGETS = { 'GET /v1/usage/budgets': { status: 200, body: { budgets: [] } } };

  it('V-0211 should refuse a login this machine does not have, as v4 did: exit 1, `No login "nope" on this machine.`', async () => {
    const { world: w, io, transport } = world({ ...LOGINS, ...FILE, ...BUDGETS });
    should(await runFy(['login', 'budget', 'nope'], w)).equal(1);
    should(io.stderr()).containEql('No login "nope" on this machine.');
    should(io.stdout()).equal('');
    // Nothing is read or written for a login that does not exist.
    should(transport.sent.some(request => request.method !== 'GET')).equal(false);
    should(transport.sent.some(request => request.path.startsWith('/v1/config/file'))).equal(false);
  });

  it('V-0211 should refuse a login that does not exist even when a budget is being set', async () => {
    const { world: w, io, transport } = world({ ...LOGINS, ...FILE, ...BUDGETS });
    should(await runFy(['login', 'budget', 'nope', '--daily-hard', '5'], w)).equal(1);
    should(io.stderr()).containEql('No login "nope" on this machine.');
    should(transport.sent.some(request => request.method !== 'GET')).equal(false);
  });

  it('V-0211 should end a known login’s show line with where to see what it spent', async () => {
    const { world: w, io } = world({ ...LOGINS, ...FILE, ...BUDGETS });
    should(await runFy(['login', 'budget', 'claude-a'], w)).equal(0);
    should(io.stdout().trim()).equal('claude-a: no budget. What it spent: `fy login check claude-a`.');
  });
});

describe('fy lesson suggest without --scope (V-0308)', () => {
  it('V-0308 should say what commander said in v4, with the usage line, exit 1, and call nothing', async () => {
    const { world: w, io, transport } = world({});
    should(await runFy(['lesson', 'suggest', 'Run bun install first.'], w)).equal(1);
    should(io.stderr()).containEql("error: required option '--scope <scope>' not specified");
    should(io.stderr()).containEql('Usage: fy lesson suggest <rule> [options]');
    should(io.stderr()).not.containEql('Invalid option');
    should(transport.sent).deepEqual([]);
  });

  it('V-0308 should name global and repo, in a plain sentence, for a value that is neither', async () => {
    const { world: w, io, transport } = world({});
    should(await runFy(['lesson', 'suggest', 'Run bun install first.', '--scope', 'project'], w)).equal(1);
    should(io.stderr()).containEql('global');
    should(io.stderr()).containEql('repo');
    should(io.stderr()).not.containEql('Invalid option');
    should(io.stderr()).not.containEql('scope: ');
    should(transport.sent).deepEqual([]);
  });

  it('V-0308 should file the lesson when --scope is given', async () => {
    const { world: w, transport } = world(
      { 'POST /v1/lessons/suggest': { status: 200, body: { summary: 'filed', outcome: 'filed' } } },
      { FY_SESSION_ID: 'f1' },
    );
    await runFy(['lesson', 'suggest', 'Run bun install first.', '--scope', 'repo'], w);
    should(transport.sent.length).be.above(0);
  });
});

/**
 * The account groups' defaults take their argument, as in v4 (account-commands.ts:207, 246, 288; its test :446): the word
 * reaches `ls` / `show` instead of being refused as an unknown sub-verb.
 */
describe('a default that takes words keeps them (fy account site / factor / site recipe)', () => {
  const ran = async (...argv: string[]) => {
    const { world: w, io, transport } = world({});
    const code = await runFy(argv, w);
    return { code, err: io.stderr(), requests: transport.sent.map(request => `${request.method} ${request.path}`) };
  };

  it('V-0019 should list one account’s sign-ins for `fy account site GITHUB`, not refuse the word', async () => {
    const { err, requests } = await ran('account', 'site', 'GITHUB');
    should(err).not.containEql('sub-verb');
    should(requests.length).be.above(0);
  });

  it('V-0009 should list one account’s 2FA keys for `fy account factor GITHUB --json`, not refuse the word', async () => {
    const { err, requests } = await ran('account', 'factor', 'GITHUB', '--json');
    should(err).not.containEql('sub-verb');
    should(requests.length).be.above(0);
  });

  it('V-0023 should show the recipe for `fy account site recipe si_…`, not refuse the word', async () => {
    const { err, requests } = await ran('account', 'site', 'recipe', 'si_0123456789abcdef');
    // `show` ran: it asked the daemon (which this fixture does not serve) instead of the shell refusing a sub-verb.
    should(err).not.containEql('sub-verb');
    should(requests.length).be.above(0);
  });

  it('V-0023 should refuse a misspelt sub-verb instead of running show on it, and run a typed one', async () => {
    const typo = await ran('account', 'site', 'recipe', 'aprove', 'si_0123456789abcdef');
    should(typo.code).equal(2);
    should(typo.err).containEql('did you mean "account site recipe approve"');
    should(typo.requests).deepEqual([]);
  });
});
