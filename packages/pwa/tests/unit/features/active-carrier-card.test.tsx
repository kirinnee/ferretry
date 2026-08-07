/**
 * The carrier disclosure, read the way somebody reads it.
 *
 * The thing under test is not the markup, it is the CLAIM: that this surface names
 * the carrier the live session won on, never the one that was preferred, and never a
 * default when nothing has been measured. The text about who can see what is
 * `packages/relay`'s and is asserted to be exactly that rather than a copy.
 */

import { chooseConnection, type ConnectionMethod, describeConnectionMethod } from '@ferretry/relay';
import { describe, it } from 'bun:test';
import should from 'should';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import { DaemonCarrierRouter } from '../../../src/lib/relay-carrier.ts';
import {
  ActiveCarrierCard,
  CARRIER_NO_FALLBACK,
  CARRIER_STREAM_DISCLOSURE,
  CARRIER_UNMEASURED,
} from '../../../src/features/carrier/active-carrier-card.tsx';
import { useActiveCarrier } from '../../../src/hooks/use-active-carrier.ts';
import { relayCrypto } from '../../support/relay.ts';
import { render, run } from '../../support/react.ts';

const DIRECT: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://studio.example' };
const HOSTED: ConnectionMethod = { kind: 'relay', relayUrl: 'https://relay.ferretry', operator: 'hosted' };

const text = (element: ReturnType<typeof render>): string => JSON.stringify(element.toJSON());

describe('the active carrier card', () => {
  it('should refuse to name a carrier before anything has been carried', () => {
    const card = render(<ActiveCarrierCard choice={undefined} relayAdvertised />);
    should(text(card)).containEql(CARRIER_UNMEASURED);
    // No observer list, because there is no carrier whose observers those would be.
    should(text(card)).not.containEql('What the parties on this path can see');
  });

  it('should name direct and show the relay package’s own observer list', () => {
    const choice = chooseConnection([{ method: DIRECT, reachable: true }]);
    const card = render(<ActiveCarrierCard choice={choice} relayAdvertised />);
    const rendered = text(card);
    should(rendered).containEql('Connected over direct.');
    for (const observer of describeConnectionMethod(DIRECT).observers) should(rendered).containEql(observer);
    should(rendered).not.containEql(CARRIER_STREAM_DISCLOSURE);
    should(rendered).not.containEql(CARRIER_NO_FALLBACK);
  });

  it('should say direct is the only carrier when nothing is advertised to fall back to', () => {
    const choice = chooseConnection([{ method: DIRECT, reachable: true }]);
    should(text(render(<ActiveCarrierCard choice={choice} relayAdvertised={false} />))).containEql(CARRIER_NO_FALLBACK);
  });

  it('should name the relay, why direct was passed over, and what a relay cannot carry', () => {
    const choice = chooseConnection([
      { method: DIRECT, reachable: false, detail: 'Failed to fetch' },
      { method: HOSTED, reachable: true },
    ]);
    const rendered = text(render(<ActiveCarrierCard choice={choice} relayAdvertised />));
    should(rendered).containEql('Hosted relay');
    should(rendered).containEql('Connected over hosted relay because direct was not reachable (Failed to fetch)');
    should(rendered).containEql('Passed over');
    should(rendered).containEql(CARRIER_STREAM_DISCLOSURE);
    // The honest hosted disclosure, not a paraphrase of it.
    should(rendered).containEql('They cannot read frame payloads, device tokens, session content, commands, output');
  });

  it('should say plainly when no carrier worked, and name every one it tried', () => {
    const choice = chooseConnection([
      { method: DIRECT, reachable: false, detail: 'Failed to fetch' },
      { method: HOSTED, reachable: false },
    ]);
    const rendered = text(render(<ActiveCarrierCard choice={choice} relayAdvertised />));
    should(rendered).containEql('No configured connection worked');
    should(rendered).containEql('unreachable, with no reason reported');
    // Nothing is presented as live: there is no carrier label and no observer list.
    should(rendered).containEql('Carrier');
    should(rendered).not.containEql('What the parties on this path can see');
  });
});

describe('subscribing to the measured carrier', () => {
  it('should publish the router’s answer, and undefined until there is one', () => {
    const router = new DaemonCarrierRouter({ crypto: relayCrypto, network: async () => new Response('ok') });
    const daemonId = 'fy_daemon_x' as DaemonId;
    let seen: unknown = 'unset';
    const Probe = (): null => {
      seen = useActiveCarrier(router, daemonId);
      return null;
    };
    render(<Probe />);
    should(seen).be.undefined();
    // The router publishes when a carrier is decided, and the hook re-reads it.
    run(() => {
      router.clearDaemon(daemonId);
    });
    should(seen).be.undefined();
  });
});
