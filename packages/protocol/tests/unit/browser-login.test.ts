import { describe, it } from 'bun:test';
import should from 'should';
import * as browser from '../../src/lib/browser.ts';
import * as browserLogin from '../../src/lib/browser-login.ts';
import type { BrowserLoginAction, BrowserLoginConnection, BrowserLoginStatus } from '../../src/lib/index.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const connection = {
  host: '127.0.0.1',
  port: 5_951,
  password: 'one-time-password',
  sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 reader@example.test',
} satisfies BrowserLoginConnection;

const closedStatus = { state: 'closed', profilePrimed: false } satisfies BrowserLoginStatus;
const openingStatus = { state: 'opening', profilePrimed: true } satisfies BrowserLoginStatus;

const openStatus = {
  state: 'open',
  profilePrimed: false,
  openedAt: INSTANT,
  expiresAt: LATER_INSTANT,
  connection,
} satisfies BrowserLoginStatus;

const closingStatus = {
  state: 'closing',
  profilePrimed: true,
  openedAt: INSTANT,
  expiresAt: LATER_INSTANT,
} satisfies BrowserLoginStatus;

const erroredStatus = {
  state: 'error',
  profilePrimed: false,
  error: 'the human browser login window could not open: x11vnc exited',
} satisfies BrowserLoginStatus;

/** A status case named by the impossible combination it must not admit. */
const statusRejects = (name: string, value: unknown): SchemaCase => ({
  name,
  schema: browserLogin.BrowserLoginStatusSchema,
  value,
});

const connectionRejects = (name: string, value: unknown): SchemaCase => ({
  name,
  schema: browserLogin.BrowserLoginConnectionSchema,
  value,
});

const schemaCases: SchemaCase[] = [
  { name: 'state', schema: browserLogin.BrowserLoginStateSchema, value: 'open' },
  { name: 'connection', schema: browserLogin.BrowserLoginConnectionSchema, value: connection },
  { name: 'status', schema: browserLogin.BrowserLoginStatusSchema, value: openStatus },
  { name: 'action', schema: browserLogin.BrowserLoginActionSchema, value: { action: 'start', minutes: 15 } },
];

describe('browser-login schemas', () => {
  it('should round-trip every public schema', () => {
    assertRoundTrips(schemaCases);
    assertCoversEverySchema(browserLogin, schemaCases);
  });

  it('should represent every login lifecycle state with exactly the fields the daemon emits', () => {
    const states = ['closed', 'opening', 'open', 'closing', 'error'] as const;
    const silentFailure = { state: 'error', profilePrimed: true } satisfies BrowserLoginStatus;
    const statuses: BrowserLoginStatus[] = [
      closedStatus,
      openingStatus,
      openStatus,
      closingStatus,
      erroredStatus,
      silentFailure,
    ];

    for (const state of states) should(browserLogin.BrowserLoginStateSchema.parse(state)).equal(state);
    should(statuses.map(status => browserLogin.BrowserLoginStatusSchema.parse(status))).deepEqual(statuses);
    should(statuses.map(status => status.state)).containDeep(states);
  });

  it('should preserve credential and operator text byte-for-byte on the states that carry it', () => {
    const padded = {
      ...openStatus,
      connection: { ...connection, password: ' password with spaces ', sshTunnel: ' ssh -N -L 5951 ' },
    } satisfies BrowserLoginStatus;
    const spokenFailure = { ...erroredStatus, error: ' VNC is restarting ' } satisfies BrowserLoginStatus;

    should(browserLogin.BrowserLoginStatusSchema.parse(padded)).deepEqual(padded);
    should(browserLogin.BrowserLoginStatusSchema.parse(spokenFailure)).deepEqual(spokenFailure);
  });

  it('should accept only the loopback VNC host the daemon binds', () => {
    should(browserLogin.BrowserLoginConnectionSchema.parse(connection).host).equal('127.0.0.1');
    assertRejects([
      connectionRejects('routable host', { ...connection, host: '10.0.0.5' }),
      connectionRejects('hostname alias', { ...connection, host: 'localhost' }),
      connectionRejects('padded loopback host', { ...connection, host: ' 127.0.0.1 ' }),
      connectionRejects('loopback range sibling', { ...connection, host: '127.0.0.2' }),
      connectionRejects('blank host', { ...connection, host: ' ' }),
      connectionRejects('missing host', { port: connection.port, password: 'p', sshTunnel: 't' }),
    ]);
  });

  it('should refuse connection credentials in any state but open', () => {
    assertRejects([
      statusRejects('closed with a live connection', { ...closedStatus, connection }),
      statusRejects('opening with a live connection', { ...openingStatus, connection }),
      statusRejects('closing with a stale connection', { ...closingStatus, connection }),
      statusRejects('error with a stale connection', { state: 'error', profilePrimed: false, connection }),
      statusRejects('open without a connection', {
        state: 'open',
        profilePrimed: false,
        openedAt: INSTANT,
        expiresAt: LATER_INSTANT,
      }),
    ]);
  });

  it('should refuse lifecycle timestamps outside open and closing', () => {
    assertRejects([
      statusRejects('closed with an opened instant', { ...closedStatus, openedAt: INSTANT }),
      statusRejects('closed with an expiry countdown', { ...closedStatus, expiresAt: LATER_INSTANT }),
      statusRejects('opening with an opened instant', { ...openingStatus, openedAt: INSTANT }),
      statusRejects('opening with an expiry countdown', { ...openingStatus, expiresAt: LATER_INSTANT }),
      statusRejects('error with an expiry countdown', { ...erroredStatus, expiresAt: LATER_INSTANT }),
      statusRejects('open without an opened instant', {
        state: 'open',
        profilePrimed: false,
        expiresAt: LATER_INSTANT,
        connection,
      }),
      statusRejects('open without an expiry', { state: 'open', profilePrimed: false, openedAt: INSTANT, connection }),
      statusRejects('closing without an opened instant', {
        state: 'closing',
        profilePrimed: true,
        expiresAt: LATER_INSTANT,
      }),
      statusRejects('closing without an expiry', { state: 'closing', profilePrimed: true, openedAt: INSTANT }),
    ]);
  });

  it('should refuse failure text outside the error state', () => {
    assertRejects([
      statusRejects('open with a failure message', { ...openStatus, error: 'VNC process exited' }),
      statusRejects('closed with a failure message', { ...closedStatus, error: 'VNC process exited' }),
      statusRejects('opening with a failure message', { ...openingStatus, error: 'VNC process exited' }),
      statusRejects('closing with a failure message', { ...closingStatus, error: 'VNC process exited' }),
      statusRejects('blank failure message', { ...erroredStatus, error: ' ' }),
    ]);
  });

  it('should refuse statuses with no state, an unknown state, or no profile marker', () => {
    assertRejects([
      statusRejects('missing state', { profilePrimed: true }),
      statusRejects('unread state', { state: 'unknown', profilePrimed: false }),
      statusRejects('per-session browser state', { state: 'stopped', profilePrimed: false }),
      statusRejects('missing profile marker', { state: 'closed' }),
      statusRejects('non-boolean profile marker', { state: 'closed', profilePrimed: 'yes' }),
      statusRejects('unmodelled extra field', { ...closedStatus, chromePid: 4_242 }),
    ]);
  });

  it('should keep the human login window distinct from per-session remote browser automation', () => {
    const remoteBrowser = {
      sessionId: 'session-1',
      state: 'stopped',
      pages: [],
      viewport: { width: 320, height: 240 },
      viewers: 0,
      persistentProfile: true,
      idleTimeoutSeconds: 60,
      capacity: { running: 0, maximum: 3 },
    };
    const loginAction = { action: 'start', minutes: 20 } satisfies BrowserLoginAction;

    should(browser.BrowserStatusSchema.safeParse(openStatus).success).be.false();
    should(browserLogin.BrowserLoginStatusSchema.safeParse(remoteBrowser).success).be.false();
    should(browserLogin.BrowserLoginActionSchema.parse(loginAction)).deepEqual(loginAction);
    should(browser.BrowserActionSchema.safeParse(loginAction).success).be.false();
  });

  it('should accept whole-minute start durations at both bounds and explicit stop or confirm intent', () => {
    const actions: BrowserLoginAction[] = [
      { action: 'start', minutes: 1 },
      { action: 'start', minutes: 60 },
      { action: 'stop' },
      { action: 'stop', primed: true },
      { action: 'confirm' },
    ];

    should(actions.map(action => browserLogin.BrowserLoginActionSchema.parse(action))).deepEqual(actions);
  });

  it('should reject malformed VNC credentials, instants, ports, and action payloads', () => {
    assertRejects([
      connectionRejects('zero port', { ...connection, port: 0 }),
      connectionRejects('port above TCP range', { ...connection, port: 65_536 }),
      connectionRejects('fractional port', { ...connection, port: 5_951.5 }),
      connectionRejects('blank password', { ...connection, password: ' ' }),
      connectionRejects('blank SSH tunnel', { ...connection, sshTunnel: ' ' }),
      connectionRejects('unmodelled credential field', { ...connection, vncPid: 4_242 }),
      statusRejects('timezone-free open instant', { ...openStatus, openedAt: '2026-07-31T12:00:00' }),
      statusRejects('timezone-free expiry', { ...openStatus, expiresAt: '2026-07-31T12:00:00' }),
      statusRejects('timezone-free closing instant', { ...closingStatus, openedAt: '2026-07-31T12:00:00' }),
      {
        name: 'zero-minute start',
        schema: browserLogin.BrowserLoginActionSchema,
        value: { action: 'start', minutes: 0 },
      },
      {
        name: 'overlong start',
        schema: browserLogin.BrowserLoginActionSchema,
        value: { action: 'start', minutes: 61 },
      },
      {
        name: 'fractional start',
        schema: browserLogin.BrowserLoginActionSchema,
        value: { action: 'start', minutes: 1.5 },
      },
      { name: 'stop duration', schema: browserLogin.BrowserLoginActionSchema, value: { action: 'stop', minutes: 1 } },
      {
        name: 'start primed flag',
        schema: browserLogin.BrowserLoginActionSchema,
        value: { action: 'start', primed: true },
      },
      {
        name: 'confirm options',
        schema: browserLogin.BrowserLoginActionSchema,
        value: { action: 'confirm', primed: true },
      },
    ]);
  });
});
