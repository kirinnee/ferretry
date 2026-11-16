import { describe, it } from 'bun:test';
import should from 'should';
import type { WardenReadScope } from '../../daemon/lib/ferret-view.ts';
import { WARDEN_STATUS_LIST_LIMIT } from '../../daemon/lib/feed.ts';
import type { WardenInvestigationRecord } from '../../daemon/lib/triage.ts';
import { at, enabled, harness } from './sweep-harness.ts';

/**
 * Audit A: a ferret reading the Warden's status sees the investigations of ITS lineage only. A targetless (pack)
 * investigation belongs to no lineage, and the filter runs BEFORE the newest-N cut so a foreign record can never push a
 * visible one out of the list.
 */

const scope: WardenReadScope = { mayRead: session => session === 'l1' };

const record = (id: string, targetId?: string): WardenInvestigationRecord => ({
  id,
  scope: targetId === undefined ? 'fleet' : 'session',
  origin: 'sweep',
  ...(targetId === undefined ? {} : { targetId }),
  startedAt: at(-60),
  finishedAt: at(-30),
  reportPath: `reports/${id}.md`,
});

const listed = async (records: readonly WardenInvestigationRecord[], reader?: WardenReadScope) => {
  const subject = harness({ config: enabled(), state: { investigations: [...records] } });
  const status = await subject.service.status(undefined, reader);
  return (status.investigations ?? []).map(entry => entry.id);
};

describe('the investigations list a scoped reader is shown', () => {
  it('should list the one aimed at its lineage and drop a foreign target and a targetless one', async () => {
    // Arrange
    const records = [record('w-foreign', 'other'), record('w-pack'), record('w-mine', 'l1')];

    // Act
    const ids = await listed(records, scope);

    // Assert
    should(ids).deepEqual(['w-mine']);
  });

  it('should show the owner, who has no scope, all of them', async () => {
    // Arrange
    const records = [record('w-foreign', 'other'), record('w-pack'), record('w-mine', 'l1')];

    // Act
    const ids = await listed(records);

    // Assert
    should(ids).deepEqual(['w-foreign', 'w-pack', 'w-mine']);
  });

  it('should narrow BEFORE the cut: a full page of foreign records does not push a visible one out', async () => {
    // Arrange
    const foreign = Array.from({ length: WARDEN_STATUS_LIST_LIMIT + 5 }, (_, index) => record(`w-f${index}`, 'other'));
    const records = [...foreign, record('w-mine', 'l1')];

    // Act
    const scoped = await listed(records, scope);
    const owner = await listed(records);

    // Assert
    should(scoped).deepEqual(['w-mine']);
    should(owner).have.length(WARDEN_STATUS_LIST_LIMIT);
    should(owner).not.containEql('w-mine');
  });
});
