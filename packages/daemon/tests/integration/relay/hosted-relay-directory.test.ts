/**
 * The one HTTP read that decides whether a fresh install is reachable from anywhere at all.
 *
 * It is asserted against a REAL loopback server rather than a stubbed fetcher wherever the property
 * involves the wire — headers, status codes, a body that is not JSON — because the whole value of
 * this adapter is what it does with answers a service can actually give it. `no-store` is checked on
 * the request that leaves, because a cached advertisement is the operator's kill switch not working.
 */

import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { HostedRelayDirectory } from '../../../src/adapters/relay/hosted-relay-directory.ts';
import { RELAY_ADVERTISEMENT_PATH } from '../../../src/lib/relay/discovery.ts';

const servers: Array<{ stop: (closeActive?: boolean) => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

/** A directory on loopback, answering exactly what a case tells it to, and recording the request. */
function directoryServing(answer: (request: Request) => Response | Promise<Response>): {
  readonly origin: string;
  readonly seen: string[];
} {
  // The URL is copied out inside the handler: Bun recycles the request once the response is
  // returned, so a stored reference reads back as an empty string.
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      seen.push(request.url);
      return answer(request);
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, seen };
}

describe('the hosted relay directory', () => {
  it('should read the advertised carrier from the protocol’s own path, uncached', async () => {
    // Arrange
    const relayUrl = 'https://relay.example';
    const directory = directoryServing(() => Response.json({ version: 1, relayUrl }));

    // Act
    const advertisement = await new HostedRelayDirectory(directory.origin).read();

    // Assert
    should(advertisement).deepEqual({ kind: 'available', relayUrl });
    should(directory.seen.map(url => new URL(url).pathname)).deepEqual([RELAY_ADVERTISEMENT_PATH]);
  });

  it('should send the request with no-store, because a cached answer is the kill switch not working', async () => {
    // Arrange — asserted on what the adapter passed to `fetch`, since a server cannot observe a
    // client-side cache mode and this is the property that keeps `relayUrl: null` immediate.
    const init: RequestInit[] = [];
    const directory = new HostedRelayDirectory('https://relay.example', {
      fetcher: async (_input, options) => {
        init.push(options ?? {});
        return Response.json({ version: 1, relayUrl: null });
      },
    });

    // Act
    const advertisement = await directory.read();

    // Assert
    should(advertisement).deepEqual({ kind: 'disabled' });
    should(init[0]?.cache).equal('no-store');
  });

  it('should ask nobody anything when this build carries no directory', async () => {
    // Arrange — a local build, a fork, a deploy that never configured an origin.
    const asked: string[] = [];
    const directory = new HostedRelayDirectory(undefined, {
      fetcher: async input => {
        asked.push(input);
        return Response.json({ version: 1, relayUrl: 'https://relay.example' });
      },
    });

    // Act
    const advertisement = await directory.read();

    // Assert — no request at all, and the reason names the build rather than a network failure that
    // never happened.
    should(asked).be.empty();
    should(advertisement).match({ kind: 'undetermined', reason: /no relay directory to ask/u });
  });

  it('should refuse an origin it may not ask, without asking it', async () => {
    // Arrange — insecure and not loopback, which is the same line the carrier itself is held to.
    const asked: string[] = [];
    const directory = new HostedRelayDirectory('http://relay.example', {
      fetcher: async input => {
        asked.push(input);
        return Response.json({ version: 1, relayUrl: 'https://relay.example' });
      },
    });

    // Act
    const advertisement = await directory.read();

    // Assert
    should(asked).be.empty();
    should(advertisement).match({ kind: 'undetermined', reason: /not an address this daemon may ask/u });
  });

  it('should turn every failure into an answer, so a dead directory cannot take a boot with it', async () => {
    // Arrange — the four ways this read fails in production.
    const refused = directoryServing(() => new Response('nope', { status: 503 }));
    const notJson = directoryServing(() => new Response('<html>hello</html>', { status: 200 }));
    const wrongShape = directoryServing(() => Response.json({ version: 9, relayUrl: 'https://relay.example' }));
    const unreachable = new HostedRelayDirectory('https://relay.example', {
      fetcher: async () => await Promise.reject(new Error('Unable to connect.')),
    });

    // Act
    const answers = [
      await new HostedRelayDirectory(refused.origin).read(),
      await new HostedRelayDirectory(notJson.origin).read(),
      await new HostedRelayDirectory(wrongShape.origin).read(),
      await unreachable.read(),
    ];

    // Assert — four `undetermined` sentences, four different reasons, and nothing thrown.
    should(answers.map(answer => answer.kind)).deepEqual([
      'undetermined',
      'undetermined',
      'undetermined',
      'undetermined',
    ]);
    should(answers[0]).match({ reason: /answered 503/u });
    should(answers[1]).match({ reason: /not a document/u });
    should(answers[2]).match({ reason: /cannot read/u });
    should(answers[3]).match({ reason: /could not reach/u });
  });

  it('should give up rather than hold the boot when the directory never answers', async () => {
    // Arrange — a server that accepts the connection and says nothing.
    const silent = directoryServing(() => new Promise<Response>(() => {}));

    // Act
    const advertisement = await new HostedRelayDirectory(silent.origin, { timeoutMs: 50 }).read();

    // Assert
    should(advertisement).match({ kind: 'undetermined', reason: /could not reach/u });
  });
});
