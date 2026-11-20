/** Fixed FAKE answers of one fake machine for the Access settings scene (no real device, key, login or pairing code). */
/** The gate's eight capabilities (`core/gate/contract/policy.ts`), spelled here because the app package never imports a plugin. */
const CAPABILITY_NAMES = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
  'sharing',
] as const;

export const stateOf = (search: string): string => new URLSearchParams(search).get('state') ?? 'default';
const state = stateOf(typeof window === 'undefined' ? '' : window.location.search);
export const DAEMON = `fy_daemon_${'a'.repeat(43)}`;
export const THIS_DEVICE = `fy_device_id_${'c'.repeat(22)}`;
const at = (iso: string) => iso;
const grantsOf = (held: Record<string, { use?: boolean; configure?: boolean }>) =>
  Object.fromEntries(
    CAPABILITY_NAMES.map(capability => [capability, { use: false, configure: false, ...held[capability] }]),
  );

export const devices = [
  {
    id: THIS_DEVICE,
    name: 'This browser',
    platform: 'browser',
    createdAt: at('2026-11-01T09:00:00.000Z'),
    lastSeenAt: at('2026-11-19T20:00:00.000Z'),
    idleExpiresAt: at('2026-12-31T00:00:00.000Z'),
    grants: grantsOf({ fleet: { use: true, configure: true }, terminal: { use: true }, filesystem: { use: true } }),
  },
  {
    id: `fy_device_id_${'d'.repeat(22)}`,
    name: state === 'long' ? "Ernest's Pixel 8 Pro with a name somebody typed far too long to fit one line" : 'Pixel 8',
    platform: 'browser',
    createdAt: at('2026-11-05T09:00:00.000Z'),
    lastSeenAt: at('2026-11-19T11:00:00.000Z'),
    idleExpiresAt: at('2026-12-31T00:00:00.000Z'),
    grants: grantsOf({ fleet: { use: true } }),
  },
  {
    id: `fy_device_id_${'e'.repeat(22)}`,
    name: 'Studio iPad',
    platform: 'browser',
    createdAt: at('2026-11-10T09:00:00.000Z'),
    lastSeenAt: at('2026-11-18T11:00:00.000Z'),
    idleExpiresAt: at('2026-12-31T00:00:00.000Z'),
    grants: grantsOf({}),
  },
];
export const mayWiden = grantsOf({ fleet: { use: true, configure: true }, terminal: { use: true } });

export const pairedView = {
  devices: state === 'empty' ? [] : devices,
  hostLocal: false,
  thisDeviceId: THIS_DEVICE,
  mayWiden,
};

const grantEntry = (capability: string) => ({
  capability,
  use: capability !== 'secrets',
  configure: capability === 'fleet',
  granted: { use: capability !== 'secrets', configure: capability === 'fleet' },
  useRefusal: capability === 'secrets' ? 'not-granted' : 'granted',
  configureRefusal: capability === 'fleet' ? 'granted' : 'not-granted',
  mayGrant: false,
  origin: capability === 'terminal' ? 'config file' : 'default',
});
export const grantsView = {
  capabilities: CAPABILITY_NAMES.map(grantEntry),
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

export const passkeys = {
  passkeys:
    state === 'empty'
      ? []
      : [{ id: 'QUJD', origin: 'https://ferretry.example.test', createdAt: at('2026-11-02T18:22:00.000Z') }],
  registration: state === 'empty' ? 'first-window' : 'confirm-existing',
  ...(state === 'empty' ? { registrationClosesAt: at('2026-11-19T23:30:00.000Z') } : {}),
  deviceName: 'This browser',
  clientName: 'fy',
};

export const security = {
  settings: {
    stepUpWindowMinutes: 15,
    deviceKeyRotationDays: 30,
    unlockOnOpen: true,
    unlockValidityHours: 8,
    stepUpOnActions: true,
    idleExpiryDays: 30,
  },
  source: 'document',
  mayWiden: false,
  widenCommand: 'fy daemon security set',
};

const record = (minutesAgo: number, event: string, actor: unknown, outcome = 'succeeded', detail: object = {}) => ({
  at: new Date(Date.parse('2026-11-19T21:00:00.000Z') - minutesAgo * 60_000).toISOString(),
  event,
  actor,
  outcome,
  ...detail,
});
export const audit = {
  kept: [
    record(12, 'device.paired', { kind: 'host' }),
    record(190, 'device.revoked', { kind: 'device', deviceId: THIS_DEVICE, deviceName: 'This browser' }),
    record(2_900, 'grants.changed', { kind: 'host' }),
  ],
  keptTotal: 5,
  records: [
    record(3, 'terminal.opened', { kind: 'device', deviceId: THIS_DEVICE, deviceName: 'This browser' }),
    record(45, 'pairing.refused', { kind: 'anonymous' }, 'refused'),
  ],
  unreadable: 0,
};

export const minted = {
  pairingId: `fy_pair_${'b'.repeat(22)}`,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  daemonId: DAEMON,
  daemonName: 'workshop-host',
  grants: 'full',
  daemonUrl: 'https://workshop.example.test',
  pairUrl: `https://ferretry.example.test/pair#v1;url=https%3A%2F%2Fworkshop.example.test;code=7F3K-Q2ND;fp=${DAEMON}`,
  reach: 'any-device',
};
