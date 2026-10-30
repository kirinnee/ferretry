import { describe, it } from 'bun:test';
import should from 'should';
import {
  compareArguments,
  type PolledRelease,
  RELEASES_PER_QUERY,
  releaseCandidates,
  releasedIn,
  tagContains,
} from '../../../src/lib/board-github/index.ts';

const release = (version: string, publishedAt: string): PolledRelease => ({ tag: `v${version}`, version, publishedAt });
const MERGED_AT = '2026-10-30T09:00:00Z';

describe('releaseCandidates', () => {
  it('should try the releases published at or after the merge, lowest version first', () => {
    const candidates = releaseCandidates(
      [
        release('4.112.0', '2026-10-30T12:00:00Z'),
        release('4.110.0', '2026-10-30T09:00:00Z'),
        release('4.111.0', '2026-10-30T11:00:00Z'),
        release('4.109.0', '2026-10-30T08:00:00Z'),
      ],
      MERGED_AT,
    );
    should(candidates?.map(entry => entry.version)).deepEqual(['4.110.0', '4.111.0', '4.112.0']);
  });

  it('should claim nothing when every release in a full window is newer than the merge', () => {
    const full = Array.from({ length: RELEASES_PER_QUERY }, (_, index) =>
      release(`4.${String(200 - index)}.0`, '2026-10-31T00:00:00Z'),
    );
    should(releaseCandidates(full, MERGED_AT)).be.null();
    should(releaseCandidates(full.slice(1), MERGED_AT)).have.length(RELEASES_PER_QUERY - 1);
    should(releaseCandidates([...full.slice(1), release('4.1.0', '2026-10-01T00:00:00Z')], MERGED_AT)).have.length(
      RELEASES_PER_QUERY - 1,
    );
  });
});

describe('compare', () => {
  it('should ask only the status of the comparison from the merge to the tag', () => {
    should(compareArguments('o/r', 'abc', 'v1.2.3')).deepEqual([
      'api',
      'repos/o/r/compare/abc...v1.2.3',
      '--jq',
      '.status',
    ]);
    should(compareArguments('o/r', 'abc', 'v1/x')[1]).equal('repos/o/r/compare/abc...v1%2Fx');
  });

  it('should read ahead or identical as contained, behind or diverged as not, and anything else as unknown', () => {
    should(tagContains('ahead\n')).be.true();
    should(tagContains('identical')).be.true();
    should(tagContains('behind')).be.false();
    should(tagContains('diverged')).be.false();
    should(tagContains('{"message":"Not Found"}')).be.null();
  });

  it('should cache a found release as its version, tag and publication', () => {
    should(releasedIn(release('4.110.0', MERGED_AT))).deepEqual({ version: '4.110.0', tag: 'v4.110.0', at: MERGED_AT });
  });
});
