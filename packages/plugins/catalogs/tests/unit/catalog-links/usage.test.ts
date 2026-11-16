import { describe, it } from 'bun:test';
import should from 'should';
import { linkUsageOf } from '../../../daemon/lib/catalog-links/usage.ts';
import { linkRig, storedLink } from './support.ts';

describe('linkUsageOf', () => {
  it('should count a link while it is pending, live or ending, and not after', async () => {
    const r = await linkRig();
    const links = (['pending', 'live', 'ending', 'ended', 'expired', 'used'] as const).map(state =>
      storedLink({
        state,
        ...(state === 'ended' || state === 'expired' || state === 'used'
          ? { endedAt: '2026-01-02T00:00:00.000Z' }
          : {}),
      }),
    );
    r.documents.document = { schemaVersion: 1, links };
    const serving = await linkUsageOf(r.documents).serving();
    should(serving.map(link => link.linkId)).deepEqual(links.slice(0, 3).map(link => link.linkId));
  });

  it('should count a change in flight against the version it is moving to as well as the one it leaves', async () => {
    const r = await linkRig();
    const moving = storedLink({
      state: 'live',
      pendingUpload: { sequence: 2, version: 3, notAfter: '2026-02-01T00:00:00.000Z' },
    });
    const staying = storedLink({
      state: 'live',
      pendingUpload: { sequence: 2, version: 1, notAfter: '2026-02-01T00:00:00.000Z' },
    });
    r.documents.document = { schemaVersion: 1, links: [moving, staying] };
    const serving = await linkUsageOf(r.documents).serving();
    should(serving.map(link => [link.linkId, link.version])).deepEqual([
      [moving.linkId, 1],
      [moving.linkId, 3],
      [staying.linkId, 1],
    ]);
  });
});
