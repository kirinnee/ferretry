import { describe, it } from 'bun:test';
import should from 'should';
import { GhSpawnRunner } from '../../../daemon/adapters/github.ts';
import { parseRepositoryAnswer } from '../../../daemon/lib/github/index.ts';
import { answer, prNode } from './support.ts';

const BANNER = '🔐 Using GitHub account: kirinnee\n';
const never = { after: () => () => undefined };

describe('GhSpawnRunner: a wrapped gh that prints a banner', () => {
  it('should answer with stdout alone, so a banner on stderr never reaches the answer parser', async () => {
    const json = answer({ prs: { 940: prNode(940) } });
    const runner = new GhSpawnRunner(
      { run: async () => ({ exitCode: 0, signal: null, stdout: json, stderr: BANNER }) },
      never,
    );
    const outcome = await runner.run(['api', 'graphql']);
    should(outcome).deepEqual({ kind: 'ok', stdout: json });
    should(
      parseRepositoryAnswer(outcome.kind === 'ok' ? outcome.stdout : '', {
        repo: 'kirinnee/ferretry',
        numbers: [940],
        branches: [],
        releases: false,
      })?.prs.get(940),
    ).be.ok();
  });
});
