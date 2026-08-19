import { afterEach, describe, it } from 'bun:test';
import { PairedDevicesViewSchema, SecretListSchema } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import should from 'should';
import type { z } from 'zod';
import { ProtocolResetInventory, type ResetInventoryApiClient } from '../../../src/adapters/daemon/reset-inventory';

/**
 * Counting what a reset destroys, over the real protocol client and the real protocol schemas.
 *
 * The fixtures below are parsed by the shipped schemas in this file's last test, so nothing here
 * asserts against an invented daemon reply. What matters is the two failure directions: a count that
 * arrives is shown to somebody deciding, and a count that does not must never stop the reset — the
 * daemon being unable to answer is one of the reasons somebody is resetting it.
 */

/** Three secrets, as the secret surface projects them: names and metadata, never a value. */
const secretsBody = {
  v: 1,
  health: 'ready',
  secrets: [
    { name: 'GITHUB_TOKEN', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
    { name: 'OPENAI_KEY', createdAt: '2026-07-02T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z' },
    { name: 'NPM_TOKEN', createdAt: '2026-07-03T00:00:00.000Z', updatedAt: '2026-07-03T00:00:00.000Z' },
  ],
  references: [],
};

/** Two paired devices, as the pairing surface projects them: no token and no digest, ever. */
const devicesBody = {
  devices: [
    {
      id: `fy_device_id_${'a'.repeat(22)}`,
      name: 'phone',
      platform: 'browser',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-05T00:00:00.000Z',
    },
    {
      id: `fy_device_id_${'b'.repeat(22)}`,
      name: 'laptop',
      platform: 'browser',
      createdAt: '2026-07-02T00:00:00.000Z',
      lastSeenAt: '2026-07-06T00:00:00.000Z',
    },
  ],
  hostLocal: true,
};

/** A real HTTP server on an EPHEMERAL loopback port — never a known port, never the live daemon. */
function serve(handler: (request: Request) => Response): { server: ReturnType<typeof Bun.serve>; url: string } {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  return { server, url: `http://127.0.0.1:${String(server.port)}` };
}

async function client(url: string): Promise<ResetInventoryApiClient> {
  const connected = await FyApiClient.connect({ baseUrl: url, token: 'test-token', version: '1.2.3' });
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> =>
      timeoutMs === undefined
        ? connected.request(path, schema, init)
        : connected.request(path, schema, init, timeoutMs),
  };
}

describe('the reset inventory', () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop(true);
  });

  it('should count secrets and paired devices from the daemon that owns them', async () => {
    // Arrange
    const paths: string[] = [];
    const { server, url } = serve(request => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return Response.json(path === '/v1/secrets' ? secretsBody : devicesBody);
    });
    servers.push(server);

    // Act
    const actual = await new ProtocolResetInventory(await client(url)).count();

    // Assert — the daemon is the authority on its own state. Counting files under the state home would
    // be the read the package split forbids, and would go stale on the next release.
    should(paths).deepEqual(['/v1/secrets', '/v1/pair/devices']);
    should(actual).deepEqual({ secrets: 3, devices: 2 });
  });

  it('should report zero of each on a machine that has neither', async () => {
    // Arrange — a fresh install, where the honest preflight says "0 paired devices" rather than nothing.
    const { server, url } = serve(request =>
      Response.json(
        new URL(request.url).pathname === '/v1/secrets'
          ? { ...secretsBody, secrets: [] }
          : { ...devicesBody, devices: [] },
      ),
    );
    servers.push(server);

    // Act + Assert
    should(await new ProtocolResetInventory(await client(url)).count()).deepEqual({ secrets: 0, devices: 0 });
  });

  it('should answer "unavailable" rather than fail the reset when a route refuses', async () => {
    // Arrange — a damaged store, a daemon mid-bootstrap, a credential the routes will not take. The
    // reset must still be reachable: a recovery path that depends on the thing being recovered from is
    // not a recovery path.
    const { server, url } = serve(request =>
      new URL(request.url).pathname === '/v1/secrets'
        ? Response.json(secretsBody)
        : Response.json({ error: 'forbidden' }, { status: 403 }),
    );
    servers.push(server);

    // Act + Assert
    should(await new ProtocolResetInventory(await client(url)).count()).be.undefined();
  });

  it('should answer "unavailable" for an answer that does not match the protocol schema', async () => {
    // Arrange — an older daemon, or an error envelope. Both are parsed rather than trusted, so neither
    // becomes an undefined field deep inside the preflight text.
    const { server, url } = serve(() => Response.json({ unexpected: true }));
    servers.push(server);

    // Act + Assert
    should(await new ProtocolResetInventory(await client(url)).count()).be.undefined();
  });

  it('should answer "unavailable" for a daemon that is not listening at all', async () => {
    // Arrange — bind an ephemeral port, learn it, then release it so nothing is there.
    const { server, url } = serve(() => Response.json(secretsBody));
    const connected = await client(url);
    await server.stop(true);

    // Act + Assert
    should(await new ProtocolResetInventory(connected).count()).be.undefined();
  });

  it('should use fixtures the shipped schemas actually accept', () => {
    // Act + Assert — so no test above asserts a count off a shape the daemon could never send.
    should(SecretListSchema.parse(secretsBody).secrets).have.length(3);
    should(PairedDevicesViewSchema.parse(devicesBody).devices).have.length(2);
  });
});
