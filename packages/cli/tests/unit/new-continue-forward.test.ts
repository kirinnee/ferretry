/**
 * `fy new --continue [words]` / `--since <dur>` is `fy link …` (owner ruling, V-0334): the shell hands it on, through its
 * REAL verb table and the REAL Conversation half, over a fake daemon. Same request, same sentences, same exit code.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import { forwardNewToLink } from '../../src/lib/forwards.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

class Answering extends RecordingTransport {
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    return { status: 200, body: { conversations: [], total: 0 } };
  }
}

const run = async (argv: readonly string[]) => {
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
    environment: {},
  });
  const code = await runFy(argv, made.world);
  return { code, err: made.io.stderr(), out: made.io.stdout(), sent: transport.sent };
};

describe('fy new --continue / --since forwards to fy link', () => {
  it('V-0334 calls the link client with the same words, since and harness as typing fy link', async () => {
    const forwarded = await run(['new', '--continue', 'fix', 'login', '--since', '7d', '--harness', 'claude']);
    const direct = await run(['link', 'fix', 'login', '--since', '7d', '--harness', 'claude']);
    should(forwarded.sent.length).equal(1);
    should(forwarded.sent[0]?.path).containEql('/v1/links/conversations');
    const queryOf = (request: DaemonRequest | undefined) => new URL(`http://x${request?.path ?? ''}`).searchParams;
    const [sent, typed] = [queryOf(forwarded.sent[0]), queryOf(direct.sent[0])];
    should(forwarded.sent[0]?.method).equal(direct.sent[0]?.method);
    should(sent.get('q')).equal('fix login');
    should(typed.get('q')).equal('fix login');
    should(sent.get('harness')).equal('claude');
    should(typed.get('harness')).equal('claude');
    // The clock is the real one: the two instants are seven days ago to within the seconds between the two runs.
    const gap = Math.abs(Date.parse(sent.get('since') ?? '') - Date.parse(typed.get('since') ?? ''));
    should(gap).be.below(5000);
    should(Date.now() - Date.parse(sent.get('since') ?? '')).be.within(7 * 86_400_000, 7 * 86_400_000 + 60_000);
    should(forwarded.code).equal(direct.code);
    should(forwarded.out).equal(direct.out);
  });

  it('V-0334 --since alone is a link listing too, and a bare --continue lists everything', async () => {
    const since = await run(['new', '--since', '2h']);
    should(since.sent[0]?.path).containEql('/v1/links/conversations');
    should(since.sent[0]?.path).containEql('since=');
    const bare = await run(['new', '--continue']);
    should(bare.sent[0]?.path).containEql('/v1/links/conversations');
    should(bare.code).equal(0);
  });

  it('V-0334 a bad --since says what fy link says and exits as fy link does, sending nothing', async () => {
    const forwarded = await run(['new', '--continue', '--since', 'soon']);
    const direct = await run(['link', '--since', 'soon']);
    should(forwarded.err).containEql('--since takes <n>d, <n>h or <n>w');
    should(forwarded.err).equal(direct.err);
    should(forwarded.code).equal(direct.code);
    should(forwarded.code).equal(2);
    should(forwarded.sent).deepEqual([]);
  });

  it('V-0334 an option that would be lost (a runtime, a start flag) is refused by name, unsent', async () => {
    const refused = await run(['new', '--continue', '--runtime', 'opus']);
    should(refused.code).equal(2);
    should(refused.err).containEql('--runtime');
    should(refused.err).containEql('link');
    should(refused.sent).deepEqual([]);
  });

  it('V-0334 a plain fy new is no continue and is left alone', () => {
    const table = buildVerbTable(registry);
    const resolved = resolveVerb(table, ['new', '--runtime', 'opus', 'brief']);
    if (resolved.kind !== 'verb') throw new Error('fy new must resolve');
    should(forwardNewToLink(resolved.entry, resolved.rest, 'fy')).be.undefined();
  });

  it('V-0334 `fy new --help` says it is the same as fy link', async () => {
    const help = await run(['new', '--help']);
    should(help.out).containEql('--continue');
    should(help.out).containEql('same as `fy link [words]`');
    should(help.out).containEql('same as `fy link --since');
  });
});
