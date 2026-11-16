/**
 * The one published carrier set: direct, then the tunnel while it is registered, then the relays — and
 * every set parsed when it is made, so a bad one fails where somebody is watching.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { RelayCarrierSource } from '../../../daemon/lib/relay/discovery.ts';
import { PublishedCarrierSet } from '../../../daemon/lib/runtime/published-carriers.ts';

const RELAY: RelayCarrierSource = {
  kind: 'discovered',
  config: { url: 'wss://rendezvous.example/fy', enabled: true, reconnectSeconds: 5 },
};

describe('the published carrier set', () => {
  it('R667 should put the tunnel after direct and before the relays, and replace the whole set on a change', () => {
    // Arrange
    const published = new PublishedCarrierSet('https://workstation.example', [RELAY]);
    const before = published.current();

    // Act
    published.tunnel('https://quiet-otter.tunnels.example');
    const during = published.current();

    // Assert
    should(during.map(carrier => carrier.kind)).deepEqual(['direct', 'tunnel', 'relay']);
    should(before.map(carrier => carrier.kind)).deepEqual(['direct', 'relay']);
    should(Object.isFrozen(during)).be.true();
    should(during).not.equal(before);
  });

  it('R182 should re-derive the set on every read: a tunnel change is live at once and withdrawing it restores the earlier set', () => {
    // Arrange
    const published = new PublishedCarrierSet('https://workstation.example', [RELAY]);
    const base = published.current().map(carrier => `${carrier.kind} ${carrier.url}`);

    // Act / Assert — the change shows on the very next read, and the withdrawal leaves nothing behind.
    published.tunnel('https://quiet-otter.tunnels.example');
    should(published.current().map(carrier => carrier.kind)).deepEqual(['direct', 'tunnel', 'relay']);
    published.tunnel(undefined);
    should(published.current().map(carrier => `${carrier.kind} ${carrier.url}`)).deepEqual(base);
  });

  it('should refuse a tunnel address no device could dial, where the change is made', () => {
    // Arrange
    const published = new PublishedCarrierSet(undefined, []);

    // Act / Assert — a plain-HTTP tunnel is not one Cloudflare serves.
    should(() => published.tunnel('http://quiet-otter.tunnels.example')).throw(/tunnel address must use https/u);
    should(published.current()).deepEqual([]);
  });
});
