import { describe, it } from 'bun:test';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import { FerretResultSchema } from '../../../contract/index.ts';
import { readFerretResult } from '../../../daemon/lib/result.ts';

const AT = '2026-10-22T12:00:00.000Z' as Instant;
const ferret = (state: FerretSummary['state']): FerretSummary => ({
  id: 'f1' as FerretSummary['id'],
  name: 'f1',
  role: 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state,
  createdAt: AT,
  stateAt: AT,
});
const DEFAULT = 'Done.';

describe('readFerretResult', () => {
  it('should hand back the done message of a stopped ferret, without its trailing newline', async () => {
    // Act
    const actual = await readFerretResult(ferret('stopped'), async () => 'Fixed it.\n', DEFAULT);

    // Assert
    should(actual).deepEqual({ id: 'f1', state: 'stopped', finished: true, finishedAt: AT, summary: 'Fixed it.' });
    should(FerretResultSchema.safeParse(actual).success).be.true();
  });

  it('should read the default sentence, or no summary, as no result', async () => {
    should((await readFerretResult(ferret('stopped'), async () => DEFAULT, DEFAULT)).summary).be.undefined();
    should((await readFerretResult(ferret('stopped'), async () => undefined, DEFAULT)).summary).be.undefined();
  });

  it('should not read the summary of a ferret that has not finished', async () => {
    // Arrange
    let reads = 0;

    // Act
    const actual = await readFerretResult(
      ferret('working'),
      async () => {
        reads += 1;
        return 'early';
      },
      DEFAULT,
    );

    // Assert
    should(actual).deepEqual({ id: 'f1', state: 'working', finished: false });
    should(reads).equal(0);
  });
});
