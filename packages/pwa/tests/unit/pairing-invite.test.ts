import { describe, it } from 'bun:test';
import {
  type CapabilityGrant,
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  type PairedDevice,
  type PairedDevicesView,
} from '@ferretry/protocol';
import should from 'should';
import {
  deviceAxisControl,
  deviceGrantPatch,
  isGrantRefusal,
  isThisDevice,
  orderedPairedDevices,
  PAIRING_EXPIRY_NOTE,
  pairedDeviceSummary,
  pairingCountdown,
  pairingRefusal,
  revokeConsequence,
  SELF_NARROW_NOTE,
} from '../../src/lib/pairing-invite.ts';

const grantsOf = (held: Partial<Record<DaemonCapability, Partial<CapabilityGrant>>> = { fleet: { use: true } }) =>
  Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false, ...held[capability] }]),
  ) as CapabilityGrants;

const device = (overrides: Partial<PairedDevice> = {}): PairedDevice => ({
  id: `fy_device_id_${'a'.repeat(22)}`,
  name: 'Pixel 8',
  platform: 'browser',
  createdAt: '2026-08-01T09:00:00.000Z',
  lastSeenAt: '2026-08-01T09:00:00.000Z',
  idleExpiresAt: '2026-12-31T00:00:00.000Z',
  grants: grantsOf(),
  ...overrides,
});

const view = (overrides: Partial<PairedDevicesView> = {}): PairedDevicesView => ({
  devices: [device()],
  hostLocal: true,
  mayWiden: grantsOf({ fleet: { use: true, configure: true }, terminal: { use: true } }),
  ...overrides,
});

describe('pairingCountdown', () => {
  it('counts down in m:ss and floors, so 0:00 never appears while the code still works', () => {
    // Arrange
    const expiresAt = '2026-08-03T12:02:00.000Z';
    const at = (offsetMs: number) => pairingCountdown(expiresAt, Date.parse(expiresAt) - offsetMs);

    // Act, Assert
    should(at(120_000).label).equal('2:00');
    should(at(65_400).label).equal('1:05');
    should(at(9_000).label).equal('0:09');
    // 900ms left floors to zero seconds but is not yet expired… and IS reported as expired, because a
    // label of 0:00 beside a live code is a code somebody stops trying to use.
    should(at(900)).deepEqual({ expired: true, secondsLeft: 0, label: '0:00' });
  });

  it('never counts below zero, and reads an unparseable instant as expired', () => {
    // A daemon that answered with something this cannot read has given no window worth relying on.
    // Treating unknown as "plenty of time" leaves a dead code on screen with a confident clock beside it.
    // Arrange, Act, Assert
    should(pairingCountdown('2026-08-03T12:02:00.000Z', Date.parse('2026-08-03T12:30:00.000Z'))).deepEqual({
      expired: true,
      secondsLeft: 0,
      label: '0:00',
    });
    should(pairingCountdown('not an instant', 0).expired).be.true();
  });
});

describe('the paired device list', () => {
  it('orders newest first and breaks ties by id, so no row moves between renders', () => {
    // A list that reshuffles is a list where somebody revokes the wrong device.
    // Arrange
    const older = device({ id: `fy_device_id_${'b'.repeat(22)}`, createdAt: '2026-07-01T09:00:00.000Z' });
    const newer = device({ id: `fy_device_id_${'c'.repeat(22)}`, createdAt: '2026-08-02T09:00:00.000Z' });
    const tieFirst = device({ id: `fy_device_id_${'d'.repeat(22)}`, createdAt: newer.createdAt });

    // Act
    const ordered = orderedPairedDevices(view({ devices: [older, tieFirst, newer] }));

    // Assert
    should(ordered.map(entry => entry.id)).deepEqual([newer.id, tieFirst.id, older.id]);
  });

  it('summarises when a device arrived, and adds last-seen only when it differs', () => {
    // Arrange, Act
    const fresh = pairedDeviceSummary(device());
    const seen = pairedDeviceSummary(device({ lastSeenAt: '2026-08-03T11:00:00.000Z' }));
    const damaged = pairedDeviceSummary(device({ createdAt: 'nonsense', lastSeenAt: 'nonsense' }));

    // Assert — a device that has never been back says nothing about it rather than repeating one date.
    should(fresh).startWith('Added ');
    should(fresh).not.containEql('last seen');
    should(seen).containEql('last seen');
    should(damaged).equal('Added an unknown time');
  });

  it('marks the caller’s own grant only when the daemon named it', () => {
    // The mark comes from the server-derived actor. A browser cannot point it at somebody else's grant,
    // and the host's own admin credential has no grant here to mark.
    // Arrange
    const mine = device();
    const other = device({ id: `fy_device_id_${'z'.repeat(22)}` });

    // Act, Assert
    should(isThisDevice(mine, view({ thisDeviceId: mine.id }))).be.true();
    should(isThisDevice(other, view({ thisDeviceId: mine.id }))).be.false();
    should(isThisDevice(mine, view())).be.false();
  });

  it('says what revoking will do before the press, including when it ends this session', () => {
    // Revoking the credential you are holding is legitimate — handing a laptop back is exactly that —
    // so it is offered rather than blocked. Being surprised by it is what is not acceptable.
    // Arrange
    const mine = device();

    // Act
    const self = revokeConsequence(mine, view({ thisDeviceId: mine.id }));
    const other = revokeConsequence(mine, view());

    // Assert
    should(self).containEql('signs this browser out');
    should(other).containEql('Pixel 8');
    should(other).containEql('added again with a new code');
  });
});

describe('pairing refusals', () => {
  it('keeps the daemon’s own sentence and adds the way out it cannot know', () => {
    // The daemon's message already names the command that changes the answer, so nothing is added to it:
    // a browser on the machine is governed like any other and gets no promise that it is exempt.
    // Arrange, Act
    const explained = pairingRefusal('the operator of this machine has not granted the UI the use of device pairing.');
    const silent = pairingRefusal('   ');

    // Assert
    should(explained).equal('the operator of this machine has not granted the UI the use of device pairing.');
    should(explained).not.containEql('never restricted');
    should(silent).startWith('This daemon did not say why.');
  });

  it('tells the operator’s decision from an outage by the daemon’s code, never by its prose', () => {
    // Getting this wrong is a dead end in both directions: an outage dressed as a permission problem
    // sends somebody hunting for a grant they have, and the reverse sends them to reboot a working daemon.
    // Arrange, Act, Assert
    should(isGrantRefusal('grant_not_granted')).be.true();
    should(isGrantRefusal('grant_undetermined')).be.true();
    should(isGrantRefusal('pairing_refused')).be.false();
    should(isGrantRefusal(undefined)).be.false();
  });

  it('states the two-minute window and its remedy in one sentence', () => {
    should(PAIRING_EXPIRY_NOTE).containEql('two minutes');
    should(PAIRING_EXPIRY_NOTE).containEql('ask for another one');
  });
});

describe('deviceGrantPatch', () => {
  it('sends the one axis touched when nothing implies another', () => {
    should(deviceGrantPatch('terminal', 'use', true)).deepEqual({ terminal: { use: true } });
    should(deviceGrantPatch('terminal', 'configure', false)).deepEqual({ terminal: { configure: false } });
  });

  it('turns use on with configure, and configure off with use', () => {
    // configure without use is not a state anybody means, and the daemon would judge it as two widens.
    should(deviceGrantPatch('filesystem', 'configure', true)).deepEqual({ filesystem: { use: true, configure: true } });
    should(deviceGrantPatch('terminal', 'use', false)).deepEqual({ terminal: { use: false, configure: false } });
  });
});

describe('deviceAxisControl', () => {
  const target = device({ grants: grantsOf({ fleet: { use: true } }) });

  it('reports an axis the device holds as on and always changeable, because narrowing is never refused', () => {
    // Arrange
    const nothingWidenable = view({ mayWiden: grantsOf({}) });

    // Act, Assert
    should(deviceAxisControl(nothingWidenable, target, 'fleet', 'use')).deepEqual({
      checked: true,
      blocked: false,
      reason: null,
    });
  });

  it('offers a widen the caller may make, and blocks one it may not with the host command', () => {
    // Act
    const allowed = deviceAxisControl(view(), target, 'terminal', 'use');
    const refused = deviceAxisControl(view(), target, 'filesystem', 'use', 'ferret');

    // Assert
    should(allowed).deepEqual({ checked: false, blocked: false, reason: null });
    should(refused.blocked).equal(true);
    should(refused.reason).containEql('ferret device grant <device> filesystem --use');
    should(refused.reason).containEql('Project filesystem use');
  });

  it('blocks configure when use would also have to be widened and may not be', () => {
    // configure on sends use on too, so a caller that may widen configure but not use cannot do either.
    // Arrange
    const onlyConfigure = view({ mayWiden: grantsOf({ filesystem: { configure: true } }) });

    // Act
    const blocked = deviceAxisControl(onlyConfigure, target, 'filesystem', 'configure');
    const fine = deviceAxisControl(
      onlyConfigure,
      device({ grants: grantsOf({ filesystem: { use: true } }) }),
      'filesystem',
      'configure',
    );

    // Assert
    should(blocked.blocked).equal(true);
    should(blocked.reason).containEql('--use');
    should(fine.blocked).equal(false);
  });

  it('warns a device that narrowing itself can only be undone elsewhere', () => {
    should(SELF_NARROW_NOTE).containEql('only be switched back on at the machine');
  });
});
