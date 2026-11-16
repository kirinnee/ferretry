import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { FileTunnelHolding } from '../../../daemon/adapters/tunnel/file-tunnel-holding.ts';
import manifest from '../../../manifest.ts';

/**
 * The holding as the daemon keeps it between runs: written through the kernel's state port (which stamps
 * `format: 1`), read back by a SECOND holding over the same folder the way a restarted daemon would, and forgotten.
 */
describe('file tunnel holding — across a daemon restart', () => {
  const value = { origin: 'https://service.example', tunnelUrl: 'https://quiet-otter.tunnels.example' };

  it('should hand a restarted daemon the holding the previous one recorded, and nothing once forgotten', async () => {
    const folder = new MemoryStateFolder();
    const before = new FileTunnelHolding(folder.port(manifest.data.state));
    should(await before.read()).equal(undefined);

    await before.record(value);

    const after = new FileTunnelHolding(folder.port(manifest.data.state));
    should(await after.read()).eql(value);
    should(JSON.parse(folder.raw(manifest.data.state[0]) ?? '')).eql({ format: 1, ...value });

    await after.forget();
    should(await new FileTunnelHolding(folder.port(manifest.data.state)).read()).equal(undefined);
    should(folder.raw(manifest.data.state[0])).equal(undefined);
  });

  it('should refuse to record a holding that names a field it does not keep, such as a connector token', async () => {
    const folder = new MemoryStateFolder();
    const holding = new FileTunnelHolding(folder.port(manifest.data.state));

    let refused: unknown;
    try {
      await holding.record({ ...value, token: 'secret-connector-token' } as never);
    } catch (error) {
      refused = error;
    }

    should(refused).be.an.Error();
    should(folder.raw(manifest.data.state[0])).equal(undefined);
  });
});
