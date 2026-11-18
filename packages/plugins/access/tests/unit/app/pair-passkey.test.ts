import { describe, expect, it } from 'bun:test';
import type { ShellPluginClient } from '@ferretry/app';
import { pairedPasskeyClient } from '../../../app/pair-passkey.ts';
import { daemonConnection } from '../../../app/shell-pairing.ts';

const connection = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceId: 'device-one',
});
const routed = { request: async () => ({}) } as unknown as ShellPluginClient;

describe('the /pair page’s reach to the machine it has just paired with', () => {
  it('P-H4 should give Access’s client on that machine once the shell has connected, looking again a few times', async () => {
    let looks = 0;
    const waits: number[] = [];
    const make = pairedPasskeyClient({
      reach: () => daemon => {
        looks += 1;
        return daemon === 'daemon-a' && looks >= 3 ? routed : undefined;
      },
      wait: async ms => {
        waits.push(ms);
      },
    });
    const client = await make(connection);
    expect(typeof client.request).toBe('function');
    expect(looks).toBe(3);
    expect(waits).toEqual([250, 250]);
  });

  it('P-H5 should give up (so the offer stays quiet) when the shell never connects, and at once with no passkey provision', async () => {
    const waits: number[] = [];
    await expect(
      pairedPasskeyClient({ reach: () => () => undefined, wait: async ms => void waits.push(ms), attempts: 3 })(
        connection,
      ),
    ).rejects.toThrow();
    expect(waits).toHaveLength(2);
    const none: number[] = [];
    await expect(
      pairedPasskeyClient({ reach: () => undefined, wait: async ms => void none.push(ms) })(connection),
    ).rejects.toThrow();
    expect(none).toEqual([]);
  });
});
