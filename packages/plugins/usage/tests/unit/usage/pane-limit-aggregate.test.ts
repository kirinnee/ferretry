import { describe, it } from 'bun:test';
import should from 'should';
import { aggregatePaneLimits } from '../../../daemon/lib/usage/pane-limit.ts';

const NOW = 1_000;

describe('aggregatePaneLimits', () => {
  it('should key a limit by its login, or by its runtime where the ferret recorded no login, and drop a row with neither', () => {
    // Act
    const limits = aggregatePaneLimits(
      [
        { login: 'main', notice: 'out of credits', spend: true, retryAt: 5_000 },
        { runtime: 'claude-work', notice: 'usage window', spend: false },
        { notice: 'nobody to blame', spend: false },
      ],
      NOW,
    );

    // Assert
    should(limits).deepEqual([
      { login: 'main', notice: 'out of credits', spend: true, retryAt: 5_000 },
      { runtime: 'claude-work', notice: 'usage window', spend: false },
    ]);
  });

  it('should prefer the login over the runtime when a ferret recorded both', () => {
    const limits = aggregatePaneLimits([{ login: 'main', runtime: 'claude-work', notice: 'n', spend: false }], NOW);

    should(limits).deepEqual([{ login: 'main', notice: 'n', spend: false }]);
  });

  it('should hold nothing for a limit whose reset has passed', () => {
    should(aggregatePaneLimits([{ login: 'main', notice: 'n', spend: true, retryAt: 1_000 }], NOW)).deepEqual([]);
  });

  it('should let the latest reset win among timed limits of one login, whatever the order they arrive in', () => {
    const rows = [
      { login: 'main', notice: 'first', spend: false, retryAt: 2_000 },
      { login: 'main', notice: 'later', spend: false, retryAt: 9_000 },
      { login: 'main', notice: 'earlier', spend: false, retryAt: 3_000 },
    ];

    should(aggregatePaneLimits(rows, NOW)).deepEqual([
      { login: 'main', notice: 'later', spend: false, retryAt: 9_000 },
    ]);
  });

  it('should let a limit with no reset time outrank a timed one, and never be displaced by one', () => {
    const open = { login: 'main', notice: 'open ended', spend: true } as const;
    const timed = { login: 'main', notice: 'timed', spend: true, retryAt: 9_000 } as const;

    should(aggregatePaneLimits([timed, open], NOW)).deepEqual([{ login: 'main', notice: 'open ended', spend: true }]);
    should(aggregatePaneLimits([open, timed], NOW)).deepEqual([{ login: 'main', notice: 'open ended', spend: true }]);
  });

  it('should keep one limit per login and per runtime, as separate keys', () => {
    const limits = aggregatePaneLimits(
      [
        { login: 'main', notice: 'a', spend: false },
        { runtime: 'main', notice: 'b', spend: false },
      ],
      NOW,
    );

    should(limits.map(limit => limit.notice)).deepEqual(['a', 'b']);
  });
});
