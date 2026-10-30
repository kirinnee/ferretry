/**
 * The carrier disclosure, read the way somebody reads it.
 *
 * The thing under test is not the markup, it is the CLAIM: that this surface names
 * the carrier the live session won on, never the one that was preferred, and never a
 * default when nothing has been measured. The text about who can see what is
 * `packages/relay`'s and is asserted to be exactly that rather than a copy.
 */

import { describe, it } from 'bun:test';
import { type ConnectionMethod, chooseConnection, describeConnectionMethod } from '@ferretry/relay';
import should from 'should';
import {
  ActiveCarrierCard,
  CARRIER_NO_FALLBACK,
  CARRIER_STREAM_DISCLOSURE,
  CARRIER_TUNNEL_STREAM_DISCLOSURE,
  CARRIER_UNMEASURED,
  CONNECTION_STATUS_LABEL,
  connectionStatusKind,
  NOT_CONNECTED_LABEL,
  SELF_HOSTING_NOTE,
  SELF_HOSTING_RUNBOOK_URL,
} from '../../../src/features/carrier/active-carrier-card.tsx';
import { stallCopy } from '../../../src/features/connection/connection-copy.ts';
import { useActiveCarrier } from '../../../src/hooks/use-active-carrier.ts';
import type { CarrierFailure, ConnectionHealthState } from '../../../src/lib/connection-health.ts';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import { DaemonCarrierRouter } from '../../../src/lib/relay-carrier.ts';
import { render, run } from '../../support/react.ts';
import { relayCrypto } from '../../support/relay.ts';

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
    should(rendered).containEql('Connection');
    should(rendered).not.containEql('What the parties on this path can see');
  });
});

const SELF: ConnectionMethod = { kind: 'relay', relayUrl: 'wss://relay.home.example/base', operator: 'self' };

const reconnecting = (failures: readonly CarrierFailure[]): ConnectionHealthState => ({
  kind: 'reconnecting',
  since: 0,
  attempt: 2,
  nextAttemptAt: null,
  failures,
  cause: 'daemon-unreachable',
  stalled: false,
});

const statusOf = (card: ReturnType<typeof render>): unknown =>
  card.root.findByProps({ role: 'status' }).props['data-connection-status'];

describe('the connection status the card leads with', () => {
  it('should lead with direct, and with which relay carried it, never a fingerprint', () => {
    const direct = render(
      <ActiveCarrierCard choice={chooseConnection([{ method: DIRECT, reachable: true }])} relayAdvertised />,
    );
    should(statusOf(direct)).equal('direct');
    should(text(direct)).containEql(CONNECTION_STATUS_LABEL.direct);

    const relayed = render(
      <ActiveCarrierCard
        choice={chooseConnection([
          { method: DIRECT, reachable: false },
          { method: SELF, reachable: true },
        ])}
        relayAdvertised
      />,
    );
    should(statusOf(relayed)).equal('relay');
    should(text(relayed)).containEql(CONNECTION_STATUS_LABEL.relay);
    should(text(relayed)).containEql('Your own relay · relay.home.example');
  });

  it('should say "not measured yet" rather than default to direct', () => {
    should(statusOf(render(<ActiveCarrierCard choice={undefined} relayAdvertised />))).equal('none');
    // A walk that ran and carried nothing was measured: it says so, and names why below.
    const refused = render(
      <ActiveCarrierCard
        choice={{ ok: false, reason: 'Tunnel only: not set up by the operator.', passedOver: [] }}
        relayAdvertised
      />,
    );
    should(statusOf(refused)).equal('none');
    should(text(refused)).containEql(NOT_CONNECTED_LABEL);
    should(text(refused)).not.containEql(CONNECTION_STATUS_LABEL.none);
    should(connectionStatusKind(undefined, { kind: 'connected' })).equal('none');
  });

  it('should say reconnecting over the carrier that last won, with the cause and each failure once', () => {
    const choice = chooseConnection([{ method: HOSTED, reachable: true }]);
    const card = render(
      <ActiveCarrierCard
        choice={choice}
        relayAdvertised
        machine="studio"
        health={reconnecting([
          { label: 'Direct', detail: 'Failed to fetch' },
          { label: 'Direct', detail: 'a duplicate the sheet drops' },
          { label: 'Hosted relay', detail: '4404' },
        ])}
      />,
    );
    const rendered = text(card);
    should(statusOf(card)).equal('reconnecting');
    should(rendered).containEql(CONNECTION_STATUS_LABEL.reconnecting);
    should(rendered).containEql(stallCopy('daemon-unreachable', 'studio').heading);
    should(rendered).containEql(stallCopy('daemon-unreachable', 'studio').advice);
    should(rendered).containEql('Failed to fetch');
    should(rendered).not.containEql('a duplicate the sheet drops');
    should(rendered).containEql('Last connected over ');
    // The relay host is the LIVE answer's detail, so it is not claimed while the link is down.
    should(rendered).not.containEql('Hosted relay · ');
  });

  it('should say reconnecting with no list when nothing has reported, and no "last" when nothing won', () => {
    const card = render(<ActiveCarrierCard choice={undefined} relayAdvertised health={reconnecting([])} />);
    const rendered = text(card);
    should(statusOf(card)).equal('reconnecting');
    should(rendered).containEql(stallCopy('daemon-unreachable', 'this machine').heading);
    should(rendered).not.containEql('Last connected over');
    should(card.root.findAllByType('li')).have.length(0);
  });

  it('should link the self-hosting runbook and offer no relay setting of its own', () => {
    const card = render(<ActiveCarrierCard choice={undefined} relayAdvertised />);
    should(text(card)).containEql(SELF_HOSTING_NOTE);
    const link = card.root.findByType('a');
    should(link.props.href).equal(SELF_HOSTING_RUNBOOK_URL);
    should(link.props.rel).equal('noreferrer noopener');
    should(card.root.findAllByType('input')).have.length(0);
    should(card.root.findAllByType('button')).have.length(0);
  });
});

describe('subscribing to the measured carrier', () => {
  it('should publish the router’s answer, and undefined until there is one', () => {
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      deviceKey: async () => undefined,
      network: async () => new Response('ok'),
    });
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

describe('the card on a Cloudflare tunnel or WebRTC (§15)', () => {
  const TUNNEL: ConnectionMethod = { kind: 'tunnel', tunnelUrl: 'https://k3x9.tunnels.example.com' };
  const WEBRTC: ConnectionMethod = { kind: 'webrtc' };

  it('should name the tunnel and its hostname, with Cloudflare’s observers and its stream caveat', () => {
    const choice = chooseConnection([
      { method: DIRECT, reachable: false, detail: 'Failed to fetch', connected: true },
      { method: WEBRTC, reachable: false, detail: 'WebRTC isn’t available in this build yet', untried: true },
      { method: TUNNEL, reachable: true },
    ]);
    const card = render(<ActiveCarrierCard choice={choice} relayAdvertised />);
    const rendered = text(card);
    should(statusOf(card)).equal('tunnel');
    should(rendered).containEql(CONNECTION_STATUS_LABEL.tunnel);
    should(rendered).containEql('k3x9.tunnels.example.com');
    should(rendered).containEql(CARRIER_TUNNEL_STREAM_DISCLOSURE);
    for (const observer of describeConnectionMethod(TUNNEL).observers) should(rendered).containEql(observer);
    // A carrier passed over without being tried says so.
    should(rendered).containEql('WebRTC');
    should(rendered).containEql(' (not tried)');
    // One that connected and then lost its session was reached, and says so rather than "unreachable".
    should(rendered).containEql(' (connected, then the session failed)');
    should(card.root.findByProps({ 'data-active-carrier': '' }).props['data-carrier-kind']).equal('tunnel');
  });

  it('should name WebRTC, with the round trip and the fallback reason the carrier measured', () => {
    const chosen = chooseConnection([{ method: WEBRTC, reachable: true }]);
    if (!chosen.ok) throw new Error('expected WebRTC');
    const card = render(
      <ActiveCarrierCard
        choice={{ ...chosen, rttMs: 23.4, fallbackReason: 'ICE restarted after a network change' }}
        relayAdvertised
      />,
    );
    const rendered = text(card);
    should(statusOf(card)).equal('webrtc');
    should(rendered).containEql(CONNECTION_STATUS_LABEL.webrtc);
    should(card.root.findByProps({ 'data-carrier-rtt': '' }).children.join('')).equal('Round trip: 23 ms');
    should(card.root.findByProps({ 'data-carrier-fallback-reason': '' }).children.join('')).equal(
      'Why not a faster carrier: ICE restarted after a network change',
    );
  });

  it('should render neither line when the carrier measured neither', () => {
    const card = render(
      <ActiveCarrierCard choice={chooseConnection([{ method: DIRECT, reachable: true }])} relayAdvertised />,
    );
    should(card.root.findAllByProps({ 'data-carrier-rtt': '' })).have.length(0);
    should(card.root.findAllByProps({ 'data-carrier-fallback-reason': '' })).have.length(0);
  });

  it('should carry the connection preference selector when given one, and hand back a change', () => {
    const chosen: string[] = [];
    const card = render(
      <ActiveCarrierCard
        choice={undefined}
        relayAdvertised
        preference={{
          value: 'auto',
          onChange: preference => chosen.push(preference),
          availability: { webrtc: false, tunnelNote: 'This machine has no tunnel yet.' },
        }}
      />,
    );
    should(card.root.findByType('legend').children.join('')).equal('How this device connects');
    const relay = card.root.findAllByType('input').find(input => input.props.value === 'relay');
    run(() => relay?.props.onChange());
    should(chosen).eql(['relay']);
    should(text(card)).containEql('This machine has no tunnel yet.');
  });
});

describe('the machine’s tunnel line (tunnels are opt-in, §15)', () => {
  const OFF = 'Tunnel: off (opt-in) — turn on with fy daemon tunnel on or Settings › Connection';
  const preference = (tunnel?: { sentence: string; off: boolean; turnOn: () => Promise<void> }) => ({
    value: 'tunnel' as const,
    onChange: () => undefined,
    availability: { webrtc: true, tunnel },
  });

  it('should say the machine’s own sentence about its tunnel beside the preference', () => {
    const card = render(
      <ActiveCarrierCard
        choice={undefined}
        relayAdvertised
        preference={preference({ sentence: OFF, off: true, turnOn: async () => undefined })}
      />,
    );
    should(card.root.findByProps({ 'data-tunnel-status': '' }).children.join('')).equal(OFF);
  });

  it('should say nothing about a tunnel the machine has not described', () => {
    const card = render(<ActiveCarrierCard choice={undefined} relayAdvertised preference={preference()} />);
    should(card.root.findAllByProps({ 'data-tunnel-status': '' })).have.length(0);
    should(
      render(<ActiveCarrierCard choice={undefined} relayAdvertised />).root.findAllByProps({
        'data-tunnel-status': '',
      }),
    ).have.length(0);
  });
});
