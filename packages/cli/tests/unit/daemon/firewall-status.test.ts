import { describe, it } from 'bun:test';
import { BROWSER_STATE_PATH } from '@ferretry/protocol';
import should from 'should';
import { ProtocolFirewallStatusReader } from '../../../src/lib/daemon/firewall-status.ts';

const client = (answer: () => Promise<unknown>) => ({
  request: (async (path: string, schema: { parse(value: unknown): unknown }) => {
    should(path).equal(BROWSER_STATE_PATH);
    return schema.parse(await answer());
  }) as never,
});

describe('ProtocolFirewallStatusReader', () => {
  it('should read the firewall the daemon put on its browser state', async () => {
    // Arrange
    const firewall = { state: 'missing', detail: 'the loopback firewall is missing: ask the host admin' };

    // Act
    const read = await new ProtocolFirewallStatusReader(client(async () => ({ state: 'stopped', firewall }))).read();

    // Assert
    should(read).eql(firewall);
  });

  it('should answer nothing when the state has no firewall, or the read fails', async () => {
    // Act + Assert
    should(await new ProtocolFirewallStatusReader(client(async () => ({ state: 'stopped' }))).read()).equal(undefined);
    should(
      await new ProtocolFirewallStatusReader(
        client(async () => {
          throw new Error('no token');
        }),
      ).read(),
    ).equal(undefined);
  });
});
