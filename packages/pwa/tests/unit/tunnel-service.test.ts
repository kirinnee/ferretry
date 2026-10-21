/**
 * The hosted tunnel service's advertisement (`docs/relay-protocol.md` §15 "Discovery"): `available: false`
 * and a read that fails are the same answer — "not set up by the operator" — and nothing throws.
 */

import { describe, test } from 'bun:test';
import should from 'should';
import {
  noTunnelReason,
  readTunnelService,
  TUNNEL_NOT_SET_UP,
  TUNNEL_NOT_YET,
  tunnelNote,
} from '../../src/lib/tunnel-service.ts';

const DIRECTORY = 'https://relay-directory.example.test';

const answering = (answer: Response | Error) => {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  return {
    asked,
    fetcher: async (url: string, init?: RequestInit): Promise<Response> => {
      asked.push({ url, init });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('reading the tunnel service advertisement', () => {
  test('asks the relay directory’s own origin, uncached, and reads available', async () => {
    const network = answering(json({ version: 1, available: true }));
    should(await readTunnelService({ directoryUrl: DIRECTORY, fetcher: network.fetcher })).equal('available');
    should(network.asked[0]?.url).equal(`${DIRECTORY}/v1/tunnel-service`);
    should(network.asked[0]?.init?.cache).equal('no-store');
  });

  test('reads available: false, and every failure, as unavailable', async () => {
    const cases: (Response | Error)[] = [
      json({ version: 1, available: false }),
      json({ version: 2, available: true }),
      json({ version: 1, available: true, extra: 1 }),
      json({ error: 'nope' }, 503),
      new Response('not json'),
      new TypeError('Failed to fetch'),
    ];
    for (const answer of cases) {
      const network = answering(answer);
      should(await readTunnelService({ directoryUrl: DIRECTORY, fetcher: network.fetcher })).equal('unavailable');
    }
  });

  test('asks nothing in a build with no directory, or one whose directory is not dialable', async () => {
    const network = answering(json({ version: 1, available: true }));
    should(await readTunnelService({ fetcher: network.fetcher })).equal('unavailable');
    should(await readTunnelService({ directoryUrl: 'http://directory.example', fetcher: network.fetcher })).equal(
      'unavailable',
    );
    should(network.asked).eql([]);
  });
});

describe('saying why there is no tunnel', () => {
  test('names the operator when the service is off, and the machine when it is on', () => {
    should(noTunnelReason('unavailable')).equal(TUNNEL_NOT_SET_UP);
    should(noTunnelReason('available')).equal(TUNNEL_NOT_YET);
    should(tunnelNote(false, 'unavailable')).equal('Not set up by the operator.');
    should(tunnelNote(false, 'available')).equal('This machine has no tunnel yet.');
  });

  test('says nothing for a machine with a tunnel, or before the service has answered', () => {
    should(tunnelNote(true, 'unavailable')).be.undefined();
    should(tunnelNote(false, undefined)).be.undefined();
  });
});
