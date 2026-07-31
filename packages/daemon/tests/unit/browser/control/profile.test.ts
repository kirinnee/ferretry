import { describe, it } from 'bun:test';
import should from 'should';
import {
  compareChromeVersions,
  highestChromeVersion,
  isPrimedMarker,
  parseBrowserProfileLease,
  sameBrowserProfileLease,
} from '../../../../src/lib/index.ts';

describe('browser profile policy', () => {
  it('should parse only complete leases and compare their identity exactly', () => {
    // Arrange
    const valid = JSON.stringify({
      sessionId: 'session',
      daemonPid: 42,
      chromePid: 43,
      acquiredAt: new Date(0).toISOString(),
    });

    // Act
    const record = parseBrowserProfileLease(valid);

    // Assert
    should(record).deepEqual({
      sessionId: 'session',
      daemonPid: 42,
      chromePid: 43,
      acquiredAt: new Date(0).toISOString(),
    });
    should(parseBrowserProfileLease('{')).be.undefined();
    should(parseBrowserProfileLease(JSON.stringify({ sessionId: '', daemonPid: 1, acquiredAt: 'bad' }))).be.undefined();
    should(sameBrowserProfileLease(record!, { ...record!, chromePid: 999 })).be.true();
    should(sameBrowserProfileLease(record!, { ...record!, acquiredAt: new Date(1).toISOString() })).be.false();
  });

  it('should retain the greatest Chrome major and trust only explicit priming', () => {
    // Act + Assert
    should(compareChromeVersions('Chrome 149.0.0.0', 'Chrome 150.0.0.0')).equal(-1);
    should(compareChromeVersions('Chrome 150.1.0.0', 'Chrome 150.0.0.0')).equal(0);
    should(compareChromeVersions('Chrome 151.0.0.0', 'Chrome 150.0.0.0')).equal(1);
    should(compareChromeVersions('unknown', 'Chrome 150.0.0.0')).be.undefined();
    should(highestChromeVersion({ createdChromeVersion: 'Chrome 151.0', latestChromeVersion: 'Chrome 150.0' })).equal(
      'Chrome 151.0',
    );
    should(isPrimedMarker({ version: 'Chrome 150', primedAt: new Date(0).toISOString() })).be.true();
    for (const marker of [
      {},
      null,
      { version: 150, primedAt: new Date().toISOString() },
      { version: 'Chrome', primedAt: 'no' },
    ]) {
      should(isPrimedMarker(marker)).be.false();
    }
  });
});
