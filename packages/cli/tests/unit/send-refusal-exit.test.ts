/**
 * `fy send <ferret>` through the shell's REAL verb table and the REAL conversation half, over a fake daemon: a send the
 * daemon refuses (no such ferret, a callsign two ferrets hold) must END non-zero, as v4's did, so a script that sends to a
 * ferret and checks `$?` is not told "sent" about a message nobody got.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

class AnsweringTransport extends RecordingTransport {
  constructor(private readonly answer: DaemonReply) {
    super();
  }
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    return this.answer;
  }
}

const run = async (answer: DaemonReply) => {
  const transport = new AnsweringTransport(answer);
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
  const code = await runFy(['send', 'joslin', 'are you there?'], made.world);
  return { code, err: made.io.stderr(), out: made.io.stdout(), transport };
};

describe('fy send when the daemon refuses', () => {
  it('a ferret nobody knows says so and exits 1', async () => {
    const { code, err, out } = await run({
      status: 404,
      body: { error: 'session not found: joslin', code: 'session_not_found' },
    });
    should(err).containEql('session not found: joslin');
    should(out).not.containEql('sent');
    should(code).equal(1);
  });

  it('a callsign two ferrets hold is refused with the sentence and exits 1', async () => {
    const { code, err } = await run({
      status: 409,
      body: { error: 'the name joslin is held by 2 sessions', code: 'ambiguous_name' },
    });
    should(err).containEql('held by 2 sessions');
    should(code).equal(1);
  });
});
