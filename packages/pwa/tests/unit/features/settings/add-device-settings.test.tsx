import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  DAEMON_CAPABILITIES,
  type GrantsView,
  type PairedDevice,
  type PairedDevicesView,
  type PairingCodeMintResponse,
  type PairingId,
  type PairingInvitationLink,
} from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import {
  AddDeviceCard,
  AddDeviceSurface,
  type PairingClientFactory,
} from '../../../../src/features/settings/add-device-settings.tsx';
import { DaemonSettingsFrame } from '../../../../src/features/settings/daemon-settings-frame.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const PAIRING_ID = `fy_pair_${'b'.repeat(22)}` as PairingId;
const DEVICE_ID = `fy_device_id_${'c'.repeat(22)}`;
const OTHER_DEVICE_ID = `fy_device_id_${'d'.repeat(22)}`;
const NOW = Date.parse('2026-08-03T12:01:00.000Z');
const originalFetch = globalThis.fetch;
const unavailableDaemonFetch = (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch;

const connection = (id = DAEMON_ID) =>
  daemonConnection({ daemonId: id, baseUrl: 'https://workstation.example.test', deviceToken: `token-${id}` });

beforeEach(() => {
  // Frame composition is the subject here; its other daemon tabs receive a
  // deterministic unavailable transport instead of the host network.
  globalThis.fetch = unavailableDaemonFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const code = {
  pairingId: PAIRING_ID,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: '2026-08-03T12:02:00.000Z',
  daemonId: DAEMON_ID,
  daemonName: 'workstation',
} as const;

/** A mint whose address any device can dial, which is the only one that gets a QR. */
const minted = (overrides: Partial<PairingInvitationLink> = {}): PairingCodeMintResponse => ({
  ...code,
  daemonUrl: 'https://workstation.example.test',
  pairUrl: `https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test;code=7F3K-Q2ND;fp=${DAEMON_ID}`,
  reach: 'any-device',
  ...overrides,
});

/**
 * The two mints that are NOT error cases and must still render.
 *
 * A loopback-bound daemon is the default install and a wildcard-bound one is serving normally. A panel
 * tested only against the dialable case is how a QR of `127.0.0.1` reached a phone.
 */
const mintedLocalOnly = (): PairingCodeMintResponse =>
  minted({
    daemonUrl: 'http://127.0.0.1:7431',
    pairUrl: `https://ferretry.pages.dev/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=7F3K-Q2ND;fp=${DAEMON_ID}`,
    reach: 'local-only',
  });
const mintedWithoutLink = (): PairingCodeMintResponse => ({ ...code, refusal: 'wildcard-bind' });
/**
 * THE DEFAULT INSTALL ONCE A RENDEZVOUS CAN BE DISCOVERED, which is the combination this file had no
 * case for. The direct address is still loopback — so the notice is owed — and another device can
 * still redeem the link, because the scanning phone finds the same hosted rendezvous the daemon did.
 * The panel renders those on two independent conditions, so only a case that is BOTH can catch them
 * being collapsed back together.
 */
const mintedRelayedLocalOnly = (): PairingCodeMintResponse =>
  minted({
    daemonUrl: 'http://127.0.0.1:7431',
    pairUrl: `https://ferretry.pages.dev/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=7F3K-Q2ND;fp=${DAEMON_ID}`,
    reach: 'local-only',
    discoveredRelayUrl: 'wss://relay.example',
  });

const device = (overrides: Partial<PairedDevice> = {}): PairedDevice => ({
  id: DEVICE_ID,
  name: 'Pixel 8',
  platform: 'browser',
  createdAt: '2026-08-01T09:00:00.000Z',
  lastSeenAt: '2026-08-03T11:00:00.000Z',
  ...overrides,
});

const view = (overrides: Partial<PairedDevicesView> = {}): PairedDevicesView => ({
  devices: [device()],
  hostLocal: true,
  thisDeviceId: DEVICE_ID,
  ...overrides,
});

/**
 * The grant view this panel reads to learn whether a password exists.
 *
 * A password IS set by default here, so a test about codes and revokes never has to think about the
 * first-pairing requirement — the tests that are about it override this.
 */
const grantsView = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => ({
    capability,
    use: true,
    configure: true,
    granted: { use: true, configure: true },
    useRefusal: 'granted',
    configureRefusal: 'granted',
    mayGrant: true,
    origin: 'default',
  })),
  governed: false,
  hostLocal: true,
  passwordSet: true,
  unlocked: false,
  ...overrides,
});

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const marked = (renderer: ReactTestRenderer, attribute: string, value?: string) =>
  renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props[attribute] !== undefined &&
      (value === undefined || node.props[attribute] === value),
  );

const card = (overrides: Partial<Parameters<typeof AddDeviceCard>[0]> = {}) =>
  render(
    <AddDeviceCard
      connection={connection()}
      view={view()}
      // Open by default, so a test about codes and revokes says nothing about the password requirement.
      // The tests that ARE about it pass their own gate.
      gate={{ kind: 'open' }}
      invite={null}
      nowMs={NOW}
      onSetPassword={() => {}}
      onMint={() => {}}
      onDiscardInvite={() => {}}
      onRevokeCode={() => {}}
      onRevokeDevice={() => {}}
      {...overrides}
    />,
  );

describe('AddDeviceCard', () => {
  it('marks itself with the daemon it belongs to, so a code cannot be read as another machine’s', () => {
    // #233's invariant, at the surface: one browser can be paired to several machines, and everything on
    // this panel — the code, the list, every revoke — belongs to exactly one of them.
    // Arrange, Act
    const renderer = card();

    // Assert
    should(marked(renderer, 'data-add-device-surface', DAEMON_ID)).have.length(1);
  });

  it('offers the button when no code is live and hides it while one is on screen', () => {
    // Two live codes cannot exist — minting replaces its predecessor on the daemon — so offering the
    // button beside a working code would quietly kill the code somebody is currently showing a phone.
    // Arrange, Act
    const idle = card();
    const showing = card({ invite: minted() });

    // Assert
    should(marked(idle, 'data-pair-mint')).have.length(1);
    should(marked(showing, 'data-pair-mint')).be.empty();
  });

  it('shows the QR, the code and the same link as selectable text', () => {
    // Cameras fail and people retype. All three carry the same credential, which is why they appear
    // together rather than as a fallback somebody has to go looking for.
    // Arrange, Act
    const renderer = card({ invite: minted() });

    // Assert
    should(marked(renderer, 'data-pair-qr')).have.length(1);
    should(marked(renderer, 'data-pair-code')).have.length(1);
    should(marked(renderer, 'data-pair-url')).have.length(1);
    expect(text(renderer)).toContain('7F3K-Q2ND');
    expect(text(renderer)).toContain('ferretry.pages.dev/pair');
    // The QR is drawn in this tab: an SVG path, not a request to anybody.
    should(marked(renderer, 'data-qr-version')).have.length(1);
    // A phone IS the caller a QR is for, so both the heading and the disclosure may say so here.
    expect(text(renderer)).toContain('Show this to the device you are adding');
    expect(text(renderer)).toContain('Show it to the phone you are adding');
  });

  it('draws no QR for an address only this machine can dial, and says who can redeem it', () => {
    // THE BLOCKER, IN THE BROWSER. The default daemon advertises loopback, and a QR of that address is
    // an offer to a phone that would dial ITSELF. The link stays — the browser reading this panel is
    // exactly the caller it works for — and what replaces the QR is the sentence saying so.
    // Arrange, Act
    const renderer = card({ invite: mintedLocalOnly() });

    // Assert
    should(marked(renderer, 'data-pair-qr')).be.empty();
    should(marked(renderer, 'data-pair-offer', 'local-only')).have.length(1);
    should(marked(renderer, 'data-pair-local-only')).have.length(1);
    should(marked(renderer, 'data-pair-url')).have.length(1);
    should(marked(renderer, 'data-pair-code')).have.length(1);
    expect(text(renderer)).toContain('Only a browser on this machine can redeem this link');
    // Never a dead end: the audience arrives with the edit that widens it.
    expect(text(renderer)).toContain('publicUrl');
    expect(text(renderer)).toContain('to the address other devices reach this machine at');
    // The heading and the disclosure must not send the reader looking for a phone that cannot use this.
    expect(text(renderer)).toContain('Open this on this machine');
    expect(text(renderer)).not.toContain('Show this to the device you are adding');
    expect(text(renderer)).toContain('Show it to a browser on this machine');
    expect(text(renderer)).not.toContain('Show it to the phone you are adding');
  });

  it('draws BOTH the QR and the local-only notice when a discovered rendezvous makes loopback redeemable', () => {
    // THE COMBINATION THAT MOTIVATED THE SPLIT, AND HAD NO TEST. The QR and the notice used to move
    // together because they only ever had one cause: a local-only link could not be redeemed elsewhere,
    // so it earned a warning INSTEAD of a QR. A loopback bind on a discoverable rendezvous breaks that
    // in half — the link IS redeemable, and the address is still local, so the reader is owed both.
    // Suppressing the notice because a QR appeared would delete the disclosure exactly when there is
    // something new to disclose. `fy pair` has the equivalent case; without this one the two surfaces
    // could silently diverge where §14 says they must agree.
    // Arrange, Act
    const renderer = card({ invite: mintedRelayedLocalOnly() });

    // Assert — both, on one panel.
    should(marked(renderer, 'data-pair-qr')).have.length(1);
    should(marked(renderer, 'data-pair-local-only')).have.length(1);
    should(marked(renderer, 'data-pair-offer', 'local-only')).have.length(1);
    // The disclosure names the rendezvous and what it can and cannot observe.
    expect(text(renderer)).toContain('wss://relay.example');
    expect(text(renderer)).toContain('another device can redeem it through');
    expect(text(renderer)).toContain('can never read the code or the exchange');
    // A QR is genuinely on the glass, so nothing may claim otherwise — the contradiction the plain
    // local-only sentence would have printed if it had been reused here unchanged.
    expect(text(renderer)).not.toContain('no QR is drawn');
    expect(text(renderer)).toContain('Show this to the device you are adding');
    // THE QR CARRIES THE ORDINARY LINK. The rendezvous is disclosed beside it and is not in the
    // fragment; the phone finds that address for itself.
    expect(text(renderer)).toContain('ferretry.pages.dev/pair#v1;');
    expect(text(renderer)).not.toContain('#v2;');
    expect(text(renderer)).not.toContain(';relay=');
  });

  it('offers no link at all when the daemon has no address, and still shows the code', () => {
    // A wildcard-bound daemon is serving normally with nothing to hand out. The code was minted and is
    // redeemable by a browser somebody points at the machine themselves, so it stays on screen; the
    // link and the QR do not exist to show.
    // Arrange, Act
    const renderer = card({ invite: mintedWithoutLink() });

    // Assert
    should(marked(renderer, 'data-pair-offer', 'refusal')).have.length(1);
    should(marked(renderer, 'data-pair-qr')).be.empty();
    should(marked(renderer, 'data-pair-url')).be.empty();
    should(marked(renderer, 'data-pair-code')).have.length(1);
    expect(text(renderer)).toContain('binds every interface');
    expect(text(renderer)).not.toContain('ferretry.pages.dev/pair#');
    // Nothing here can be shown to anybody, so neither the heading nor the disclosure should say so.
    expect(text(renderer)).toContain('No link to hand out');
    expect(text(renderer)).not.toContain('Show this to the device you are adding');
    expect(text(renderer)).toContain('keep it to yourself');
    expect(text(renderer)).not.toContain('Show it to the phone you are adding');
    expect(text(renderer)).not.toContain('Show it to a browser on this machine');
  });

  it('counts down while the code lives and says plainly when it has run out', () => {
    // Arrange
    const live = card({ invite: minted() });
    const dead = card({ invite: minted(), nowMs: Date.parse('2026-08-03T12:05:00.000Z') });

    // Act, Assert
    should(marked(live, 'data-pair-countdown', 'live')).have.length(1);
    expect(text(live)).toContain('1:00');
    should(marked(dead, 'data-pair-countdown', 'expired')).have.length(1);
    // An expired code stops being shown as a credential: no QR, no link, and the reason it is gone.
    should(marked(dead, 'data-pair-qr')).be.empty();
    should(marked(dead, 'data-pair-url')).be.empty();
    expect(text(dead)).toContain('can no longer add a device');
    // And the headline says the code is gone rather than pointing at a hand-off that no longer exists —
    // there is nothing left on this screen for anybody to be shown.
    expect(text(dead)).toContain('This code has run out');
    expect(text(dead)).not.toContain('Show this to the device you are adding');
  });

  it('says what the code gives away while it is on screen', () => {
    // Arrange, Act
    const rendered = text(card({ invite: minted() }));

    // Assert
    expect(rendered).toContain('Anyone who reads this code');
    expect(rendered).toContain('camera app');
  });

  it('separates ending the code on the machine from clearing it off this screen', () => {
    // A person who presses Done and walks away has NOT revoked anything, and being wrong about that is
    // how a live code is left on a machine somebody thinks they closed.
    // Arrange
    const revoked: string[] = [];
    const discarded: string[] = [];
    const renderer = card({
      invite: minted(),
      onRevokeCode: () => revoked.push('revoke'),
      onDiscardInvite: () => discarded.push('discard'),
    });

    // Act
    run(() => marked(renderer, 'data-pair-revoke-code')[0]?.props.onClick());
    run(() => marked(renderer, 'data-pair-discard')[0]?.props.onClick());

    // Assert
    should([revoked, discarded]).deepEqual([['revoke'], ['discard']]);
    expect(text(renderer)).toContain('keeps working until it runs out');
  });

  it('lists each device with what revoking it will do, and marks the caller’s own', () => {
    // Arrange
    const renderer = card({
      view: view({ devices: [device(), device({ id: OTHER_DEVICE_ID, name: 'iPad' })] }),
    });

    // Act, Assert
    should(marked(renderer, 'data-paired-device')).have.length(2);
    should(marked(renderer, 'data-paired-device-self')).have.length(1);
    expect(text(renderer)).toContain('signs this browser out of this machine');
    expect(text(renderer)).toContain('iPad’s access');
  });

  it('reports each revoke against the device the row is for', () => {
    // Arrange
    const asked: string[] = [];
    const renderer = card({
      view: view({ devices: [device(), device({ id: OTHER_DEVICE_ID, name: 'iPad' })] }),
      onRevokeDevice: id => asked.push(id),
    });

    // Act
    run(() => marked(renderer, 'data-pair-revoke-device', OTHER_DEVICE_ID)[0]?.props.onClick());

    // Assert
    should(asked).deepEqual([OTHER_DEVICE_ID]);
  });

  it('never presents an empty list as evidence that nothing may reach the machine', () => {
    // Arrange, Act
    const rendered = text(card({ view: view({ devices: [], thisDeviceId: undefined }) }));

    // Assert
    expect(rendered).toContain('No devices are paired');
    expect(rendered).toContain('Adding a device is how that changes');
  });

  it('says whether this browser is at the machine, from the daemon’s answer rather than the URL', () => {
    // A page on 127.0.0.1 can be reaching the daemon through the relay, so the address this browser
    // dialled says nothing. `hostLocal` is the carrier's answer and the only one worth rendering.
    // Arrange, Act
    const here = card();
    const away = card({ view: view({ hostLocal: false }) });

    // Assert
    should(marked(here, 'data-pair-host-local', 'yes')).have.length(1);
    should(marked(away, 'data-pair-host-local', 'no')).have.length(1);
    expect(text(away)).toContain('away from this machine');
  });

  it('renders a daemon’s failure sentence whole', () => {
    // Arrange, Act
    const rendered = text(
      card({ failure: { message: 'the operator has not granted the UI the use of device pairing.' } }),
    );

    // Assert
    expect(rendered).toContain('has not granted the UI the use of device pairing');
  });

  it('explains rather than blanks when a link is too long to encode', () => {
    // Arrange — a pair URL far longer than this protocol produces, which no version-20 symbol can hold.
    const renderer = card({ invite: minted({ pairUrl: `https://ferretry.pages.dev/pair#${'x'.repeat(900)}` }) });

    // Act, Assert
    should(marked(renderer, 'data-pair-qr-failure')).have.length(1);
    should(marked(renderer, 'data-pair-url')).have.length(1);
  });

  it('offers no code at all until an operator password exists, and the control that fixes it', () => {
    // THE REQUIREMENT, RATHER THAN A NUDGE. `fleet.configure` is on by default for a governed caller, so a
    // device paired to a machine with no password can provision the host — writing runnable wrappers into
    // the operator's accounts — with nothing to prove. Requiring the password at the moment remote access
    // is created deletes that state instead of warning about it.
    // Arrange, Act
    const renderer = card({ gate: { kind: 'needs-password', local: true } });

    // Assert — no button, the reason in its place, and the control that satisfies it in the same flow.
    should(marked(renderer, 'data-pair-mint')).be.empty();
    should(marked(renderer, 'data-pair-needs-password', 'local')).have.length(1);
    should(marked(renderer, 'data-operator-password')).have.length(1);
    expect(text(renderer)).toContain('runnable files into your accounts');
  });

  it('names the two places that can set one when the reader is not at the machine', () => {
    // An install with devices already paired and no password reaches this: the requirement applies to the
    // NEXT pairing, and a remote browser cannot set the password. So it says where it CAN be done rather
    // than offering a control that would be refused.
    // Arrange, Act
    const renderer = card({ gate: { kind: 'needs-password', local: false } });

    // Assert
    should(marked(renderer, 'data-pair-mint')).be.empty();
    should(marked(renderer, 'data-pair-needs-password', 'remote')).have.length(1);
    // No form here: this browser could not succeed, and a control that fails on press teaches somebody the
    // product is broken.
    should(marked(renderer, 'data-password-field')).be.empty();
    expect(text(renderer)).toContain('fy daemon password set');
  });

  it('offers the button when it cannot tell, and renders the daemon’s refusal whole', () => {
    // WHERE THE RULE LIVES DECIDES THIS. While the browser was the enforcer, an unreadable grant view had
    // to fail closed — the requirement would otherwise have lapsed on exactly that machine. The daemon
    // enforces it now, so withholding the control would only hide a button from somebody whose machine is
    // standing by to answer. It taps, the daemon refuses, and this panel prints that sentence verbatim —
    // remedy included — rather than composing a second one of its own.
    // Arrange, Act
    const refusal =
      'this machine has no operator password, so it will not hand out a pairing code. Set one with ' +
      '`fy daemon password set` on this machine.';
    const renderer = card({
      gate: { kind: 'open' },
      failure: { message: refusal, code: 'pairing_needs_operator_password' },
    });

    // Assert
    should(marked(renderer, 'data-pair-mint')).have.length(1);
    should(marked(renderer, 'data-pair-failure')).have.length(1);
    should(marked(renderer, 'data-pair-needs-password')).be.empty();
    expect(text(renderer)).toContain(refusal);
  });
});

/** A client that answers each route from the fixtures, and records what was asked. */
function fakeClient(world: {
  readonly devices?: PairedDevicesView;
  readonly grants?: GrantsView;
  readonly grantsFailure?: unknown;
  readonly passwordFailure?: unknown;
  readonly mintFailure?: unknown;
  readonly readFailure?: unknown;
  readonly revokeFailure?: unknown;
  readonly calls?: string[];
  readonly bodies?: string[];
}): PairingClientFactory {
  let passwordSet = world.grants?.passwordSet ?? true;
  return async () => ({
    request: async (path, schema, init) => {
      const method = init?.method ?? 'GET';
      world.calls?.push(`${method} ${path}`);
      // Recorded so a test can assert the password never reached a URL, and reached a BODY instead.
      if (typeof init?.body === 'string') world.bodies?.push(init.body);
      if (path === '/v1/grants' && method === 'GET') {
        if (world.grantsFailure !== undefined) throw world.grantsFailure;
        return schema.parse({ ...(world.grants ?? grantsView()), passwordSet });
      }
      if (path === '/v1/grants/password' && method === 'PUT') {
        if (world.passwordFailure !== undefined) throw world.passwordFailure;
        passwordSet = (JSON.parse(String(init?.body ?? '{}')) as { password?: string }).password !== undefined;
        return schema.parse({ passwordSet });
      }
      if (path === '/v1/pair/devices' && method === 'GET') {
        if (world.readFailure !== undefined) throw world.readFailure;
        return schema.parse(world.devices ?? view());
      }
      if (path === '/v1/pair/code' && method === 'POST') {
        if (world.mintFailure !== undefined) throw world.mintFailure;
        return schema.parse(minted());
      }
      if (path.startsWith('/v1/pair/code/') && method === 'DELETE') {
        if (world.revokeFailure !== undefined) throw world.revokeFailure;
        return schema.parse({ pairingId: PAIRING_ID, status: 'expired', expiresAt: minted().expiresAt });
      }
      if (path.startsWith('/v1/pair/devices/') && method === 'DELETE') {
        if (world.revokeFailure !== undefined) throw world.revokeFailure;
        return schema.parse({ devices: [], hostLocal: true });
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  });
}

describe('AddDeviceSurface', () => {
  it('reads the device list for the daemon it was given and then offers the button', async () => {
    // Arrange
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;

    // Act
    await runAsync(async () => {
      renderer = render(<AddDeviceSurface connection={connection()} createClient={fakeClient({ calls })} />);
    });

    // Assert
    should(calls).deepEqual(['GET /v1/pair/devices', 'GET /v1/grants']);
    should(marked(renderer as ReactTestRenderer, 'data-pair-mint')).have.length(1);
  });

  it('requires the first password, sets it in a BODY, and only then offers the button', async () => {
    // THE WHOLE FIRST-PAIRING JOURNEY, in one test: no button while the machine has no password, the
    // control in its place, and the button once the daemon says a password exists. The credential rule is
    // asserted on the same path — the value reaches a body and never a URL.
    // Arrange — a fresh machine with nothing paired and no password.
    const calls: string[] = [];
    const bodies: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface
          connection={connection()}
          createClient={fakeClient({
            calls,
            bodies,
            devices: view({ devices: [] }),
            grants: grantsView({ passwordSet: false }),
          })}
          now={() => NOW}
        />,
      );
    });
    const surface = renderer as ReactTestRenderer;
    const before = marked(surface, 'data-pair-mint').length;

    // Act — type it twice and submit, which is the only path that can reach the daemon.
    await runAsync(async () => {
      marked(surface, 'data-password-field')[0]?.props.onChange({ target: { value: 'the-first-one' } });
    });
    await runAsync(async () => {
      marked(surface, 'data-password-confirm-field')[0]?.props.onChange({ target: { value: 'the-first-one' } });
    });
    await runAsync(async () => {
      surface.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });

    // Assert
    should(before).equal(0);
    should(calls).deepEqual([
      'GET /v1/pair/devices',
      'GET /v1/grants',
      'PUT /v1/grants/password',
      // Re-read, because `passwordSet` is what decides whether this panel may offer a code at all.
      'GET /v1/grants',
    ]);
    should(marked(surface, 'data-pair-mint')).have.length(1);
    should(marked(surface, 'data-pair-needs-password')).be.empty();
    // In a BODY, and in no path or query anywhere.
    should(bodies).deepEqual([JSON.stringify({ password: 'the-first-one' })]);
    should(calls.some(call => call.includes('the-first-one'))).be.false();
    // And nowhere on screen: no value, no masked form, no length.
    expect(text(surface)).not.toContain('the-first-one');
  });

  it('reports a refused password without pretending the requirement is met', async () => {
    // A gate this browser failed to set is a gate that does not exist, and showing the button anyway would
    // hand out a code the requirement was supposed to stand in front of.
    // Arrange
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface
          connection={connection()}
          createClient={fakeClient({
            grants: grantsView({ passwordSet: false }),
            passwordFailure: Object.assign(new Error('this daemon refused the password'), { code: 'grant_forbidden' }),
          })}
          now={() => NOW}
        />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => {
      marked(surface, 'data-password-field')[0]?.props.onChange({ target: { value: 'a-good-password' } });
    });
    await runAsync(async () => {
      marked(surface, 'data-password-confirm-field')[0]?.props.onChange({ target: { value: 'a-good-password' } });
    });
    await runAsync(async () => {
      surface.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });

    // Assert — the daemon's own sentence, and still no button.
    should(marked(surface, 'data-password-failure')).have.length(1);
    expect(text(surface)).toContain('this daemon refused the password');
    should(marked(surface, 'data-pair-mint')).be.empty();
  });

  it('still offers the button when it could not read whether a password exists', async () => {
    // The device list read fine; the grant read did not. That does not make the panel broken and it does not
    // make this browser the authority: the daemon refuses a mint on a passwordless machine on its own
    // account, with its own sentence. So the honest surface here offers the control and renders whatever
    // comes back — the alternative hides a button from the one reader whose machine could still answer.
    // Arrange, Act
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface
          connection={connection()}
          createClient={fakeClient({ grantsFailure: new Error('the daemon did not answer') })}
          now={() => NOW}
        />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Assert — the list rendered, the button is there, and nothing pre-empts the daemon with a guess.
    should(marked(surface, 'data-paired-device')).have.length(1);
    should(marked(surface, 'data-pair-mint')).have.length(1);
    should(marked(surface, 'data-pair-needs-password')).be.empty();
    // The failed grant read is not reported as a pairing failure either: nothing has been asked of the
    // daemon yet, and an alert about a read this panel recovered from would be noise.
    should(marked(surface, 'data-pair-failure')).be.empty();
  });

  it('mints, shows the code, and revokes it against the id the mint answered with', async () => {
    // Arrange
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface connection={connection()} createClient={fakeClient({ calls })} now={() => NOW} />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-pair-mint')[0]?.props.onClick());
    const showed = marked(surface, 'data-pair-code').length;
    await runAsync(async () => marked(surface, 'data-pair-revoke-code')[0]?.props.onClick());

    // Assert — and the code is gone from the screen once the machine has ended it.
    should(showed).equal(1);
    should(calls).deepEqual([
      'GET /v1/pair/devices',
      // The grant read is what tells this panel whether a password exists, and therefore whether it may
      // offer a code at all. It happens WITH the list rather than at the press, because the requirement
      // has to be explained before somebody reaches for the button.
      'GET /v1/grants',
      'POST /v1/pair/code',
      `DELETE /v1/pair/code/${PAIRING_ID}`,
    ]);
    should(marked(surface, 'data-pair-code')).be.empty();
  });

  it('keeps a code on screen when the revoke failed, because it is still live on the machine', async () => {
    // Hiding it would tell somebody a door was shut while it is open.
    // Arrange
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface
          connection={connection()}
          createClient={fakeClient({ revokeFailure: new Error('daemon unreachable') })}
          now={() => NOW}
        />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-pair-mint')[0]?.props.onClick());
    await runAsync(async () => marked(surface, 'data-pair-revoke-code')[0]?.props.onClick());

    // Assert
    should(marked(surface, 'data-pair-code')).have.length(1);
    should(marked(surface, 'data-pair-failure')).have.length(1);
  });

  it('drops the held code when the reader switches to another daemon', async () => {
    // A live credential must not cross the boundary everything else here is keyed by.
    // Arrange
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<AddDeviceSurface connection={connection()} createClient={fakeClient({})} now={() => NOW} />);
    });
    const surface = renderer as ReactTestRenderer;
    await runAsync(async () => marked(surface, 'data-pair-mint')[0]?.props.onClick());
    should(marked(surface, 'data-pair-code')).have.length(1);

    // Act
    await runAsync(async () => {
      surface.update(
        <AddDeviceSurface
          connection={connection(`fy_daemon_${'z'.repeat(43)}`)}
          createClient={fakeClient({})}
          now={() => NOW}
        />,
      );
    });

    // Assert
    should(marked(surface, 'data-pair-code')).be.empty();
  });

  it('shows the daemon’s refusal instead of an empty machine when the list cannot be read', async () => {
    // An empty list over a daemon this browser could not reach would read as "my phone was unpaired",
    // which is exactly wrong.
    // Arrange
    const refusal = Object.assign(
      new Error('the operator of this machine has not granted the UI the use of device pairing.'),
      { code: 'grant_not_granted' },
    );
    let renderer: ReactTestRenderer | undefined;

    // Act
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface connection={connection()} createClient={fakeClient({ readFailure: refusal })} />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Assert
    should(marked(surface, 'data-pair-refusal')).have.length(1);
    should(marked(surface, 'data-pair-mint')).be.empty();
    expect(text(surface)).toContain('has not granted the UI the use of device pairing');
    expect(text(surface)).toContain('Pairing from the machine itself is never restricted');
  });

  it('reports a failed mint without pretending a code exists', async () => {
    // Arrange
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface
          connection={connection()}
          createClient={fakeClient({ mintFailure: new Error('the daemon refused') })}
        />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-pair-mint')[0]?.props.onClick());

    // Assert
    should(marked(surface, 'data-pair-code')).be.empty();
    should(marked(surface, 'data-pair-failure')).have.length(1);
  });

  it('replaces the list with the daemon’s answer when a device is revoked', async () => {
    // Arrange
    const calls: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<AddDeviceSurface connection={connection()} createClient={fakeClient({ calls })} />);
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-pair-revoke-device', DEVICE_ID)[0]?.props.onClick());

    // Assert
    should(calls).containEql(`DELETE /v1/pair/devices/${DEVICE_ID}`);
    should(marked(surface, 'data-paired-device')).be.empty();
  });

  it('keeps a device listed when its revoke failed, because it can still reach the machine', async () => {
    // The list is only ever replaced by the daemon's own answer. Dropping a row on a failed revoke would
    // tell somebody a phone had lost access while it still has it — the one direction that must not go
    // wrong here.
    // Arrange
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface
          connection={connection()}
          createClient={fakeClient({ revokeFailure: new Error('daemon unreachable') })}
        />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-pair-revoke-device', DEVICE_ID)[0]?.props.onClick());

    // Assert
    should(marked(surface, 'data-paired-device')).have.length(1);
    should(marked(surface, 'data-pair-failure')).have.length(1);
  });

  it('mounts from the daemon settings frame, keyed to that frame’s daemon', async () => {
    // The panel is reached through the frame in production, and the frame is what supplies the
    // connection. A panel that fetched from anywhere else would not be daemon-scoped at all.
    //
    // A REAL DOM here, unlike every test above: the frame renders the shared BottomSheet, whose reduced-
    // motion effect reads `window`. That is a document fact rather than a tree fact, so it needs the
    // environment the sibling frame suites use.
    // Arrange, Act
    const view = await mount(
      <DaemonSettingsFrame
        connection={connection()}
        connections={[connection()]}
        name="Studio workstation"
        createPairingClient={fakeClient({})}
      />,
    );
    const tab = must(
      view.container.querySelector<HTMLButtonElement>('[data-daemon-panel="devices"]'),
      'the Add a device tab',
    );
    await interact(() => tab.click());

    // Assert
    should(view.container.querySelectorAll(`[data-add-device-surface="${DAEMON_ID}"]`)).have.length(1);
    await view.unmount();
  });

  it('says it is still reading rather than showing an empty machine', async () => {
    // Arrange — a client that never resolves, which is what a slow daemon looks like.
    const pending: PairingClientFactory = () => new Promise(() => {});
    let renderer: ReactTestRenderer | undefined;

    // Act
    await runAsync(async () => {
      renderer = render(<AddDeviceSurface connection={connection()} createClient={pending} />);
    });

    // Assert
    expect(text(renderer as ReactTestRenderer)).toContain('Reading which devices may reach this machine');
  });
});
