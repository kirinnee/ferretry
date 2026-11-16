import { describe, it } from 'bun:test';
import should from 'should';
import { packVerbs } from '../../../cli/lib/verbs.ts';
import { FakePackGateway } from './fixtures.ts';

/** The verbs over a gateway whose Clean up start is refused, and the terminal they write to. */
function refusing() {
  const gateway = new FakePackGateway();
  gateway.started = { outcome: 'refused', message: 'Clean up has no folder to run its ferret in.' };
  const out: string[] = [];
  const err: string[] = [];
  const verbs = packVerbs({
    client: {} as never,
    gateway,
    io: { out: text => out.push(text), err: text => err.push(text), isTty: false },
    host: {},
  });
  return { verbs, out, err };
}

describe('the guide verbs that start a ferret', () => {
  it('should exit non-zero, naming the refusal on stderr, when Clean up cannot start', async () => {
    const { verbs, out, err } = refusing();

    const code = await verbs['guide clean-up']({ args: [], options: {} });

    should(code).not.equal(0);
    should(err.join('')).containEql('Clean up has no folder to run its ferret in.');
    should(out).deepEqual([]);
  });

  it('should exit non-zero, naming the refusal on stderr, when Write it for me cannot start', async () => {
    const { verbs, err } = refusing();

    const code = await verbs['guide write']({ args: [], options: {} });

    should(code).not.equal(0);
    should(err.join('')).containEql('guide write:');
  });
});
