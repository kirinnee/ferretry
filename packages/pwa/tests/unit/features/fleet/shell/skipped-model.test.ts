import { describe, expect, it } from 'bun:test';
import {
  SKIPPED_REASON,
  skippedCountLine,
  skippedItems,
} from '../../../../../src/features/fleet/shell/skipped-model.ts';
import { runtime } from '../account-support.ts';

describe('skippedItems', () => {
  it('should word each path inside the runtime with the one plain reason, never a folder on disk', () => {
    const items = skippedItems({ ...runtime({ name: 'claude-one' }), skipped: ['skills/review', 'commands/ship.md'] });

    expect(items).toEqual([
      { within: 'skills/review', reason: SKIPPED_REASON },
      { within: 'commands/ship.md', reason: SKIPPED_REASON },
    ]);
    expect(JSON.stringify(items)).not.toContain('/home/');
    expect(SKIPPED_REASON).not.toContain('/');
  });

  it('should have nothing for a runtime the daemon names nothing for', () => {
    expect(skippedItems(runtime({ name: 'claude-one' }))).toEqual([]);
  });
});

describe('skippedCountLine', () => {
  it('should count one and many', () => {
    expect(skippedCountLine(1)).toBe('1 item skipped');
    expect(skippedCountLine(3)).toBe('3 items skipped');
  });
});
