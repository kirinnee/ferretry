import { describe, it } from 'bun:test';
import { type RelayEnvironment, relayFetch } from '../../src/adapters/index.ts';
import relayWorker from '../../src/adapters/worker.ts';
import { RELAY_PROTOCOL_ID } from '../../src/lib/index.ts';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const stranger = `fy_daemon_${'b'.repeat(43)}`;

function environment(configured?: string) {
  const routed: string[] = [];
  const value: RelayEnvironment = {
    RENDEZVOUS: {
      idFromName: name => {
        routed.push(String(name));
        return name;
      },
      get: () => ({ fetch: async () => new Response('durable', { status: 101 }) }),
    },
    RELAY_DAEMON_IDS: configured,
  };
  return { value, routed };
}

function upgrade(path: string): Request {
  return new Request(`https://relay.example${path}`, { headers: { Upgrade: 'WebSocket' } });
}

describe('relay worker route', () => {
  it('should route an allowed daemon to its own durable rendezvous', async () => {
    const { value, routed } = environment(daemonId);
    const response = await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/daemon`), value);
    should(response.status).equal(101);
    should(routed).deepEqual([`${RELAY_PROTOCOL_ID}:${daemonId}`]);
  });

  it('should refuse a fingerprint this deployment does not carry, without allocating anything', async () => {
    const { value, routed } = environment(daemonId);
    const response = await relayFetch(upgrade(`/v1/rendezvous/${stranger}/client`), value);
    should(response.status).equal(404);
    should(routed).deepEqual([]);
  });

  it('should serve nobody when the deployment lists nobody', async () => {
    const { value, routed } = environment(undefined);
    should((await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/client`), value)).status).equal(404);
    should(routed).deepEqual([]);
  });

  it('should answer a path that is not a rendezvous exactly as it answers an unknown daemon', async () => {
    const { value } = environment(daemonId);
    should((await relayFetch(upgrade('/'), value)).status).equal(404);
    should((await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/admin`), value)).status).equal(404);
  });

  it('should refuse a plain request to a socket route', async () => {
    const { value, routed } = environment(daemonId);
    const response = await relayFetch(new Request(`https://relay.example/v1/rendezvous/${daemonId}/client`), value);
    should(response.status).equal(426);
    should(routed).deepEqual([]);
  });

  it('should expose the same handler as the module default the platform loads', async () => {
    const { value } = environment(daemonId);
    should((await relayWorker.fetch(upgrade(`/v1/rendezvous/${daemonId}/daemon`), value)).status).equal(101);
  });
});
