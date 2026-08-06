import { describe, expect, it } from 'bun:test';
import type {
  PairedDevice,
  PairedDevicesView,
  PairingCodeMintResponse,
  PairingId,
  PairingInvitationLink,
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

const connection = (id = DAEMON_ID) =>
  daemonConnection({ daemonId: id, baseUrl: 'https://workstation.example.test', deviceToken: `token-${id}` });

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
    // Never a dead end: the audience arrives with the one edit that widens it.
    expect(text(renderer)).toContain('set publicUrl to the address other devices reach this machine at');
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
});

/** A client that answers each route from the fixtures, and records what was asked. */
function fakeClient(world: {
  readonly devices?: PairedDevicesView;
  readonly mintFailure?: unknown;
  readonly readFailure?: unknown;
  readonly revokeFailure?: unknown;
  readonly calls?: string[];
}): PairingClientFactory {
  return async () => ({
    request: async (path, schema, init) => {
      const method = init?.method ?? 'GET';
      world.calls?.push(`${method} ${path}`);
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
