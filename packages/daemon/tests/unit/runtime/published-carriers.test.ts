/**
 * The one published carrier set: direct, then the tunnel while it is registered, then the relays — and
 * every set parsed when it is made, so a bad one fails where somebody is watching.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { RelayCarrierSource } from '../../../src/lib/relay/discovery.ts';
import { fixedCarrierView, PublishedCarrierSet } from '../../../src/lib/runtime/published-carriers.ts';

const RELAY: RelayCarrierSource = {
  kind: 'discovered',
  config: { url: 'wss://rendezvous.example/fy', enabled: true, reconnectSeconds: 5 },
};

describe('the published carrier set', () => {
  it('should put the tunnel after direct and before the relays, and replace the whole set on a change', () => {
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

  it('should refuse a tunnel address no device could dial, where the change is made', () => {
    // Arrange
    const published = new PublishedCarrierSet(undefined, []);

    // Act / Assert — a plain-HTTP tunnel is not one Cloudflare serves.
    should(() => published.tunnel('http://quiet-otter.tunnels.example')).throw(/tunnel address must use https/u);
    should(published.current()).deepEqual([]);
  });

  it('should hold a fixed set as one parsed, frozen answer', () => {
    // Arrange
    const view = fixedCarrierView([{ kind: 'direct', url: 'https://workstation.example' }]);

    // Act / Assert
    should(view.current()).equal(view.current());
    should(Object.isFrozen(view.current())).be.true();
    should(() => fixedCarrierView([{ kind: 'relay', url: 'ws://rendezvous.example' }])).throw(/must be wss\/https/u);
  });
});
