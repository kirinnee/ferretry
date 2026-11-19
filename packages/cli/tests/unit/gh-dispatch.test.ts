/**
 * `fy gh -- <anything>` through the shell's REAL verb table, the REAL git-accounts half and a fake daemon (r9 B10). The
 * `gh` shim on a ferret's PATH is `exec fy gh -- "$@"`, so every shim command arrives here: the verb must resolve to
 * `gh` itself (never to a sub-verb of it, `pr` being no sub-verb), and what reaches the daemon is gh's argv ALONE, byte
 * for byte: no `--account`, not the outer `--`.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

const OK: DaemonReply = { status: 200, body: { exitCode: 0, stdout: 'done\n', stderr: '' } };

class Answering extends RecordingTransport {
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    return OK;
  }
}

const run = async (words: readonly string[], environment: Record<string, string> = { PWD: '/work/app' }) => {
  const transport = new Answering();
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
  const code = await runFy([...words], made.world);
  return { code, err: made.io.stderr(), out: made.io.stdout(), transport };
};

const bodyOf = (transport: RecordingTransport) => transport.sent[0]?.body as { argv: string[]; account?: string };

describe('fy gh through the real verb table', () => {
  it('`fy gh -- pr list` (what the shim runs) reaches the daemon as gh pr list', async () => {
    const { code, out, transport } = await run(['gh', '--', 'pr', 'list']);
    should(code).equal(0);
    should(out).equal('done\n');
    should(transport.sent[0]?.path).equal('/v1/git-accounts/gh/run');
    should(bodyOf(transport)).eql({ argv: ['pr', 'list'], cwd: '/fake-cwd' });
  });

  it('a literal argv survives: spaces, newlines, quotes, a leading -, --help, an inner --, an empty word', async () => {
    const argv = [
      'pr',
      'list',
      '--search',
      'is:open label:"a b"',
      'two\nlines',
      "it's",
      '-x',
      '--help',
      '--json',
      'n',
      '--',
      '',
    ];
    const { code, transport } = await run(['gh', '--', ...argv]);
    should(code).equal(0);
    should(bodyOf(transport).argv).eql(argv);
  });

  it('every gh command reaches the daemon, not a refusal of an unknown sub-verb', async () => {
    for (const command of [['api', 'user'], ['issue', 'view', '3'], ['run', 'watch', '9'], ['doctor'], ['pr']]) {
      const { code, err, transport } = await run(['gh', '--', ...command]);
      should(err).equal('');
      should(code).equal(0);
      should(bodyOf(transport).argv).eql(command);
    }
  });

  it("fy's own --account and the outer -- never reach gh's argv; the account travels as the account", async () => {
    const { transport } = await run(['gh', '--account', 'me', '--', 'pr', 'list', '--account', 'x']);
    should(bodyOf(transport)).eql({ argv: ['pr', 'list', '--account', 'x'], cwd: '/fake-cwd', account: 'me' });
    const owner = await run(['gh', '--account=me', 'pr', 'list']);
    should(bodyOf(owner.transport)).eql({ argv: ['pr', 'list'], cwd: '/fake-cwd', account: 'me' });
  });

  it('waits for the daemon’s own 5-minute budget (a followed pr checks --watch), not the transport’s 60 s', async () => {
    const { transport } = await run(['gh', '--', 'pr', 'checks', '--watch']);
    should(transport.options[0]?.timeoutMs).equal(330_000);
  });

  it('the pane check is its own verb, `fy gh-doctor`', async () => {
    const { code, err } = await run(['gh-doctor'], { PWD: '/work/app' });
    should(code).equal(1);
    should(err).containEql('not started with Ferretry');
  });
});
