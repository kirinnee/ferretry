import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type CapabilityGrant,
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  type DeviceGrantsPatch,
  type PairedDevice,
  type PairedDevicesView,
  type PairingCodeMintResponse,
  type PairingId,
  type PairingInvitationLink,
} from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { ReactTestRenderer } from 'react-test-renderer';
import should from 'should';
import {
  AddDeviceCard,
  AddDeviceSurface,
  type PairingClientFactory,
} from '../../../../src/features/settings/add-device-settings.tsx';
import { DaemonSettingsFrame } from '../../../../src/features/settings/daemon-settings-frame.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DaemonClientProvider } from '../../../../src/lib/store.tsx';
import { interact, mount, must } from '../../../support/dom.ts';
import { render, run, runAsync } from '../../../support/react.ts';
import { pageRule, ruleList } from '../../../support/sign-in-rule-fixtures.ts';

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const PAIRING_ID = `fy_pair_${'b'.repeat(22)}` as PairingId;
const DEVICE_ID = `fy_device_id_${'c'.repeat(22)}`;
const OTHER_DEVICE_ID = `fy_device_id_${'d'.repeat(22)}`;
const NOW = Date.parse('2026-08-03T12:01:00.000Z');
const originalFetch = globalThis.fetch;
const unavailableDaemonFetch = (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch;

const connection = (id = DAEMON_ID) =>
  daemonConnection({ daemonId: id, baseUrl: 'https://workstation.example.test', deviceId: `token-${id}` });

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

const grantsOf = (held: Partial<Record<DaemonCapability, Partial<CapabilityGrant>>> = { fleet: { use: true } }) =>
  Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false, ...held[capability] }]),
  ) as CapabilityGrants;

/** What the caller below may turn ON: fleet both ways and a terminal's use, nothing else. */
const MAY_WIDEN = grantsOf({ fleet: { use: true, configure: true }, terminal: { use: true } });

const device = (overrides: Partial<PairedDevice> = {}): PairedDevice => ({
  id: DEVICE_ID,
  name: 'Pixel 8',
  platform: 'browser',
  createdAt: '2026-08-01T09:00:00.000Z',
  lastSeenAt: '2026-08-03T11:00:00.000Z',
  idleExpiresAt: '2026-12-31T00:00:00.000Z',
  grants: grantsOf(),
  ...overrides,
});

const view = (overrides: Partial<PairedDevicesView> = {}): PairedDevicesView => ({
  devices: [device()],
  hostLocal: true,
  thisDeviceId: DEVICE_ID,
  mayWiden: MAY_WIDEN,
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
      invite={null}
      nowMs={NOW}
      onMint={() => {}}
      onDiscardInvite={() => {}}
      onRevokeCode={() => {}}
      onRevokeDevice={() => {}}
      onChangeDeviceGrants={() => {}}
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

  it('never says a browser is at the machine, whatever the daemon reports about the request', () => {
    // A browser is a paired device wherever it runs; only the CLI is at the machine. So no badge
    // claims either, and the view's `hostLocal` does not move any sentence.
    // Arrange, Act
    const here = text(card());
    const away = text(card({ view: view({ hostLocal: false }) }));

    // Assert
    for (const rendered of [here, away]) {
      expect(rendered).not.toContain('at this machine');
      expect(rendered).not.toContain('away from this machine');
    }
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

  it('offers the button beside a refused mint and renders the daemon’s sentence whole', () => {
    // The step-up is the carrier's business: a refusal that still reaches this panel is shown verbatim,
    // and the button stays so the person can try again.
    // Arrange, Act
    const refusal = 'the operator has not granted the UI the use of device pairing.';
    const renderer = card({ failure: { message: refusal, code: 'grant_not_granted' } });

    // Assert
    should(marked(renderer, 'data-pair-mint')).have.length(1);
    should(marked(renderer, 'data-pair-failure')).have.length(1);
    expect(text(renderer)).toContain(refusal);
  });

  it('says nothing about a password or an unlock anywhere on the panel', () => {
    // Arrange, Act
    const idle = text(card());
    const showing = text(card({ invite: minted() }));

    // Assert
    expect(idle).not.toMatch(/password|unlock/i);
    expect(showing).not.toMatch(/password|unlock/i);
  });
});

describe('AddDeviceCard capabilities', () => {
  const IPAD = device({
    id: OTHER_DEVICE_ID,
    name: 'iPad',
    grants: grantsOf({ fleet: { use: true, configure: true } }),
  });
  const switchFor = (renderer: ReactTestRenderer, id: string, capability: string, axis: string) =>
    marked(renderer, 'data-device-grant', `${id}:${capability}.${axis}`)[0];

  it('puts eight capabilities by two axes behind a disclosure on every device, closed by default', () => {
    // Sixteen switches per device would bury the list at 390px, so the rows stay a summary line.
    // Arrange, Act
    const renderer = card({ view: view({ devices: [device(), IPAD] }) });

    // Assert
    should(marked(renderer, 'data-device-capabilities')).have.length(2);
    should(marked(renderer, 'data-device-capabilities')[0]?.props.open).equal(false);
    should(marked(renderer, 'data-device-capability')).have.length(16);
    should(marked(renderer, 'data-device-grant')).have.length(32);
    for (const capability of DAEMON_CAPABILITIES)
      should(marked(renderer, 'data-device-capability', capability)).have.length(2);
    // The summary says how much this device holds without opening anything.
    expect(text(renderer)).toContain('1 of 8');
    expect(text(renderer)).toContain('Secrets');
  });

  it('opens the disclosure a screenshot or deep link asks for, and says none for a device with nothing', () => {
    // Arrange, Act
    const renderer = card({
      view: view({ devices: [device({ grants: grantsOf({}) }), IPAD] }),
      capabilitiesOpenFor: OTHER_DEVICE_ID,
    });

    // Assert
    should(marked(renderer, 'data-device-capabilities', OTHER_DEVICE_ID)[0]?.props.open).equal(true);
    should(marked(renderer, 'data-device-capabilities', DEVICE_ID)[0]?.props.open).equal(false);
    should(marked(renderer, 'data-device-capabilities-count')[0]?.children.join('')).equal('none');
    // The disclosure is the browser's own: toggling it is reflected, never persisted.
    run(() =>
      marked(renderer, 'data-device-capabilities', DEVICE_ID)[0]?.props.onToggle({ currentTarget: { open: true } }),
    );
    should(marked(renderer, 'data-device-capabilities', DEVICE_ID)[0]?.props.open).equal(true);
  });

  it('shows each switch as the device’s own grant, so a device holding fleet.use reads on and nothing else', () => {
    // Arrange, Act
    const renderer = card();

    // Assert
    should(switchFor(renderer, DEVICE_ID, 'fleet', 'use')?.props['aria-checked']).equal(true);
    should(switchFor(renderer, DEVICE_ID, 'fleet', 'configure')?.props['aria-checked']).equal(false);
    should(switchFor(renderer, DEVICE_ID, 'terminal', 'use')?.props['aria-checked']).equal(false);
    should(switchFor(renderer, DEVICE_ID, 'secrets', 'use')?.props['aria-checked']).equal(false);
  });

  it('disables a widen the caller may not make and puts the reason and the host command beside it', () => {
    // A switch that fails on press teaches somebody the product is broken; the machine decided, and the
    // sentence beside the switch says which command does it instead.
    // Arrange, Act
    const renderer = card({ clientName: 'ferret' });

    // Assert
    const refused = switchFor(renderer, DEVICE_ID, 'filesystem', 'use');
    should(refused?.props.disabled).equal(true);
    should(refused?.props['data-device-grant-blocked']).equal('yes');
    const reason = marked(renderer, 'data-device-grant-reason', `${DEVICE_ID}:filesystem.use`);
    should(reason).have.length(1);
    expect(text(renderer)).toContain('ferret device grant <device> filesystem --use');
    // A widen it MAY make is a live switch with nothing beside it.
    should(switchFor(renderer, DEVICE_ID, 'terminal', 'use')?.props.disabled).equal(false);
    should(marked(renderer, 'data-device-grant-reason', `${DEVICE_ID}:terminal.use`)).be.empty();
  });

  it('threads the app’s binary name by default and never leaves the caller without a remedy', () => {
    // Arrange, Act
    const renderer = card();

    // Assert
    expect(text(renderer)).toContain('fy device grant <device> secrets --use');
  });

  it('keeps narrowing live even when nothing at all may be widened', () => {
    // Narrowing needs only a step-up, and the router raises that prompt; the browser never pre-empts it.
    // Arrange, Act
    const renderer = card({ view: view({ mayWiden: grantsOf({}), devices: [IPAD] }) });

    // Assert
    should(switchFor(renderer, OTHER_DEVICE_ID, 'fleet', 'use')?.props.disabled).equal(false);
    should(switchFor(renderer, OTHER_DEVICE_ID, 'fleet', 'configure')?.props.disabled).equal(false);
    should(switchFor(renderer, OTHER_DEVICE_ID, 'terminal', 'use')?.props.disabled).equal(true);
  });

  it('reports the partial patch a press means, including the configure-implies-use coupling', () => {
    // Arrange
    const asked: [string, DeviceGrantsPatch][] = [];
    const renderer = card({
      view: view({
        devices: [device(), IPAD],
        mayWiden: grantsOf({ fleet: { use: true, configure: true }, terminal: { use: true, configure: true } }),
      }),
      onChangeDeviceGrants: (id, patch) => asked.push([id, patch]),
    });

    // Act
    run(() => switchFor(renderer, DEVICE_ID, 'terminal', 'use')?.props.onClick());
    run(() => switchFor(renderer, DEVICE_ID, 'terminal', 'configure')?.props.onClick());
    run(() => switchFor(renderer, OTHER_DEVICE_ID, 'fleet', 'use')?.props.onClick());
    run(() => switchFor(renderer, OTHER_DEVICE_ID, 'fleet', 'configure')?.props.onClick());

    // Assert
    should(asked).deepEqual([
      [DEVICE_ID, { terminal: { use: true } }],
      [DEVICE_ID, { terminal: { use: true, configure: true } }],
      [OTHER_DEVICE_ID, { fleet: { use: false, configure: false } }],
      [OTHER_DEVICE_ID, { fleet: { configure: false } }],
    ]);
  });

  it('marks the caller’s own row and warns that narrowing oneself is undone only elsewhere', () => {
    // Arrange, Act
    const renderer = card({ view: view({ devices: [device(), IPAD] }) });

    // Assert — exactly one note, on the row that is this device, and none on the other.
    should(marked(renderer, 'data-device-grant-self-note')).have.length(1);
    should(marked(renderer, 'data-paired-device-self')).have.length(1);
    expect(text(renderer)).toContain('only be switched back on at the machine');
  });

  it('shows a refusal on the device it was for, whole, and not on its neighbours', () => {
    // Arrange, Act
    const sentence =
      'terminal.use can only be turned on at the machine: run `fy device grant <device> terminal --use`.';
    const renderer = card({
      view: view({ devices: [device(), IPAD] }),
      grantFailure: { deviceId: OTHER_DEVICE_ID, failure: { message: sentence, code: 'grant_forbidden' } },
    });

    // Assert
    should(marked(renderer, 'data-device-grant-failure')).have.length(1);
    should(marked(renderer, 'data-device-grant-failure', OTHER_DEVICE_ID)).have.length(1);
    expect(text(renderer)).toContain('can only be turned on at the machine');
  });

  it('names no password or unlock anywhere in the capabilities', () => {
    // Arrange, Act
    const rendered = text(card({ capabilitiesOpenFor: DEVICE_ID }));

    // Assert
    expect(rendered).not.toMatch(/password|unlock/i);
  });
});

/** A client that answers each route from the fixtures, and records what was asked. */
function fakeClient(world: {
  readonly devices?: PairedDevicesView;
  readonly mintFailure?: unknown;
  readonly readFailure?: unknown;
  readonly revokeFailure?: unknown;
  readonly grantFailure?: unknown;
  readonly patches?: { readonly deviceId: string; readonly body: DeviceGrantsPatch }[];
  readonly calls?: string[];
  readonly rules?: unknown;
}): PairingClientFactory {
  let current = world.devices ?? view();
  return async () => ({
    request: async (path, schema, init) => {
      const method = init?.method ?? 'GET';
      world.calls?.push(`${method} ${path}`);
      if (path === '/v1/pair/devices' && method === 'GET') {
        if (world.readFailure !== undefined) throw world.readFailure;
        return schema.parse(current);
      }
      if (path.endsWith('/grants') && method === 'PATCH') {
        const deviceId = decodeURIComponent(path.slice('/v1/pair/devices/'.length, -'/grants'.length));
        if (world.grantFailure !== undefined) throw world.grantFailure;
        const body = JSON.parse(String(init?.body)) as DeviceGrantsPatch;
        world.patches?.push({ deviceId, body });
        // The daemon answers with the WHOLE view, which is what the panel must render — not its own guess.
        current = {
          ...current,
          devices: current.devices.map(candidate =>
            candidate.id === deviceId
              ? {
                  ...candidate,
                  grants: Object.fromEntries(
                    DAEMON_CAPABILITIES.map(capability => [
                      capability,
                      { ...candidate.grants[capability], ...body[capability] },
                    ]),
                  ) as CapabilityGrants,
                }
              : candidate,
          ),
        };
        return schema.parse(current);
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
        return schema.parse({ devices: [], hostLocal: true, mayWiden: MAY_WIDEN });
      }
      if (path === '/v1/sign-in-rules' && world.rules !== undefined) return schema.parse(world.rules);
      throw new Error(`unexpected request ${method} ${path}`);
    },
  });
}

describe('AddDeviceSurface and standing sign-in rules', () => {
  const surfaceWith = async (rulesOffered: boolean, calls: string[]) => {
    let renderer: ReactTestRenderer | undefined;
    const rules = ruleList({ rules: [pageRule({ approvedWith: { deviceId: DEVICE_ID, device: 'Pixel 8' } })] });
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface
          connection={connection()}
          createClient={fakeClient({ calls, rules })}
          rulesOffered={rulesOffered}
        />,
      );
    });
    return renderer as ReactTestRenderer;
  };

  it('says under a device how many rules its passkey approved when the machine offers rules', async () => {
    const calls: string[] = [];
    const surface = await surfaceWith(true, calls);

    should(calls).containEql('GET /v1/sign-in-rules');
    should(marked(surface, 'data-device-rules', DEVICE_ID)).have.length(1);
  });

  it('asks nothing about rules, and draws no note, when the machine does not offer them', async () => {
    const calls: string[] = [];
    const surface = await surfaceWith(false, calls);

    should(calls).not.containEql('GET /v1/sign-in-rules');
    should(marked(surface, 'data-device-rules')).have.length(0);
  });
});

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
    should(calls).deepEqual(['GET /v1/pair/devices']);
    should(marked(renderer as ReactTestRenderer, 'data-pair-mint')).have.length(1);
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
    should(calls).deepEqual(['GET /v1/pair/devices', 'POST /v1/pair/code', `DELETE /v1/pair/code/${PAIRING_ID}`]);
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
    expect(text(surface)).not.toContain('never restricted');
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
    // A REAL DOM here, unlike every test above, as in the sibling frame suites. The frame is a list of
    // panel rows; a row asks the page to move the address, and the address names the panel it opens.
    // Arrange
    const opened: (string | null)[] = [];
    const list = await mount(
      <DaemonSettingsFrame
        connection={connection()}
        name="Studio workstation"
        createPairingClient={fakeClient({})}
        onOpenPanel={panel => opened.push(panel)}
      />,
    );
    try {
      const row = must(
        list.container.querySelector<HTMLButtonElement>('[data-daemon-panel="devices"]'),
        'the Devices row',
      );
      // Act
      await interact(() => row.click());
      // Assert
      should(opened).eql(['devices']);
    } finally {
      await list.unmount();
    }

    // Arrange, Act
    const view = await mount(
      <DaemonSettingsFrame
        connection={connection()}
        name="Studio workstation"
        createPairingClient={fakeClient({})}
        panel="devices"
        onOpenPanel={() => undefined}
      />,
    );
    try {
      // Assert
      should(view.container.querySelectorAll(`[data-add-device-surface="${DAEMON_ID}"]`)).have.length(1);
    } finally {
      await view.unmount();
    }
  });

  it('sends the partial patch through the client, renders the view the daemon answered with, and not its own guess', async () => {
    // Arrange
    const calls: string[] = [];
    const patches: { readonly deviceId: string; readonly body: DeviceGrantsPatch }[] = [];
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<AddDeviceSurface connection={connection()} createClient={fakeClient({ calls, patches })} />);
    });
    const surface = renderer as ReactTestRenderer;

    // Act — configure on also turns use on, in one request.
    await runAsync(async () =>
      marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.configure`)[0]?.props.onClick(),
    );

    // Assert
    should(calls).containEql(`PATCH /v1/pair/devices/${DEVICE_ID}/grants`);
    should(patches).deepEqual([{ deviceId: DEVICE_ID, body: { terminal: { use: true, configure: true } } }]);
    should(marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.use`)[0]?.props['aria-checked']).equal(true);
    should(marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.configure`)[0]?.props['aria-checked']).equal(
      true,
    );
  });

  it('turns configure off with use, and re-reads nothing it was not told', async () => {
    // Arrange
    const patches: { readonly deviceId: string; readonly body: DeviceGrantsPatch }[] = [];
    const wide = view({ devices: [device({ grants: grantsOf({ terminal: { use: true, configure: true } }) })] });
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface connection={connection()} createClient={fakeClient({ devices: wide, patches })} />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.use`)[0]?.props.onClick());

    // Assert
    should(patches[0]?.body).deepEqual({ terminal: { use: false, configure: false } });
    should(marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.configure`)[0]?.props['aria-checked']).equal(
      false,
    );
  });

  it('shows a refused change inline on its device and leaves every switch as the daemon last said', async () => {
    // Arrange
    const refusal = Object.assign(
      new Error(
        'terminal.use can only be turned on from a device that holds it: run `fy device grant <device> terminal --use`.',
      ),
      { code: 'grant_forbidden' },
    );
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <AddDeviceSurface connection={connection()} createClient={fakeClient({ grantFailure: refusal })} />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.use`)[0]?.props.onClick());

    // Assert
    should(marked(surface, 'data-device-grant-failure', DEVICE_ID)).have.length(1);
    expect(text(surface)).toContain('can only be turned on from a device that holds it');
    should(marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.use`)[0]?.props['aria-checked']).equal(false);
    // And the next attempt clears the old sentence before it asks again.
    await runAsync(async () => marked(surface, 'data-device-grant', `${DEVICE_ID}:fleet.use`)[0]?.props.onClick());
    should(marked(surface, 'data-device-grant-failure')).have.length(1);
  });

  it('does nothing before the list has loaded, because there is no view to change', async () => {
    // Arrange — a client that never resolves leaves nothing on screen to press; the loading state has no switch.
    const pending: PairingClientFactory = () => new Promise(() => {});
    let renderer: ReactTestRenderer | undefined;

    // Act
    await runAsync(async () => {
      renderer = render(<AddDeviceSurface connection={connection()} createClient={pending} />);
    });

    // Assert
    should(marked(renderer as ReactTestRenderer, 'data-device-grant')).be.empty();
  });

  it('changes grants through the app’s routed client, which is where a step-up refusal is retried', async () => {
    // THE STEP-UP IS THE CARRIER'S: it raises the passkey prompt on `grant_step_up_required` and sends the
    // request again, once. What this panel owes is to make the call through THAT client and never a plain
    // network one — so no createClient is injected, and the client the provider names is the only way out.
    // Arrange
    const seen: string[] = [];
    let current = view();
    const routed = {
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        seen.push(`${init?.method ?? 'GET'} ${path}`);
        if (init?.method === 'PATCH')
          current = {
            ...current,
            devices: [device({ grants: grantsOf({ fleet: { use: true }, terminal: { use: true } }) })],
          };
        return schema.parse(current);
      },
    } as unknown as FyApiClient;
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <DaemonClientProvider client={async () => routed}>
          <AddDeviceSurface connection={connection()} />
        </DaemonClientProvider>,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.use`)[0]?.props.onClick());

    // Assert
    should(seen).deepEqual(['GET /v1/pair/devices', `PATCH /v1/pair/devices/${DEVICE_ID}/grants`]);
    should(marked(surface, 'data-device-grant', `${DEVICE_ID}:terminal.use`)[0]?.props['aria-checked']).equal(true);
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
