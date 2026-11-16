import { describe, it } from 'bun:test';
import should from 'should';
import { type DuplicateAsk, DuplicateSweep, type DuplicatePass } from '../../../daemon/lib/board/index.ts';

const POSSIBLE: DuplicateAsk = {
  kind: 'same-subject',
  members: [
    { ferret: 'lead', id: 'A1' },
    { ferret: 'child', id: 'A3' },
  ],
  why: 'they ask the same thing',
};

const sweepWith = (sweep: () => Promise<DuplicatePass>) => {
  const warnings: string[] = [];
  return { warnings, sweep: new DuplicateSweep({ asks: { sweep }, diagnostics: { warn: m => warnings.push(m) } }) };
};

describe('the sweep for duplicate asks', () => {
  it('should answer how many asks the pass closed and keep what it only suspects for the health report', async () => {
    const { sweep } = sweepWith(async () => ({ closed: 2, possible: [POSSIBLE] }));

    should(await sweep.run()).equal(2);
    should(sweep.possible()).eql([POSSIBLE]);
  });

  it('should run one pass at a time: a caller during a run waits for it', async () => {
    // Arrange
    let passes = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { sweep } = sweepWith(async () => {
      passes += 1;
      await gate;
      return { closed: 1, possible: [] };
    });

    // Act
    const first = sweep.run();
    const second = sweep.run();
    release();

    // Assert
    should(await Promise.all([first, second])).eql([1, 1]);
    should(passes).equal(1);
    await sweep.run();
    should(passes).equal(2);
  });

  it('should never reject: a failed pass is a warning and closes nothing', async () => {
    const { sweep, warnings } = sweepWith(async () => {
      throw new Error('the ledgers cannot be listed');
    });

    should(await sweep.run()).equal(0);
    should(warnings).eql(['the sweep of duplicate asks failed: the ledgers cannot be listed']);
  });
});
