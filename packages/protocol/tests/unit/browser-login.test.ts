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

const openStatus = {
  state: 'open',
  profilePrimed: false,
  openedAt: INSTANT,
  expiresAt: LATER_INSTANT,
  connection,
} satisfies BrowserLoginStatus;

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

  it('should represent every login lifecycle state and optional status data', () => {
    const states = ['closed', 'opening', 'open', 'closing', 'error'] as const;
    const minimal = { state: 'closed', profilePrimed: true } satisfies BrowserLoginStatus;
    const errored = { state: 'error', profilePrimed: false, error: 'VNC process exited' } satisfies BrowserLoginStatus;

    for (const state of states) should(browserLogin.BrowserLoginStateSchema.parse(state)).equal(state);
    should(browserLogin.BrowserLoginStatusSchema.parse(minimal)).deepEqual(minimal);
    should(browserLogin.BrowserLoginStatusSchema.parse(errored)).deepEqual(errored);
  });

  it('should preserve credential and operator text byte-for-byte while rejecting blanks', () => {
    const exact = {
      ...openStatus,
      connection: {
        ...connection,
        host: ' 127.0.0.1 ',
        password: ' password with spaces ',
        sshTunnel: ' ssh -N -L 5951 ',
      },
      error: ' VNC is restarting ',
    } satisfies BrowserLoginStatus;

    should(browserLogin.BrowserLoginStatusSchema.parse(exact)).deepEqual(exact);
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
      { name: 'blank host', schema: browserLogin.BrowserLoginConnectionSchema, value: { ...connection, host: ' ' } },
      { name: 'zero port', schema: browserLogin.BrowserLoginConnectionSchema, value: { ...connection, port: 0 } },
      {
        name: 'port above TCP range',
        schema: browserLogin.BrowserLoginConnectionSchema,
        value: { ...connection, port: 65_536 },
      },
      {
        name: 'fractional port',
        schema: browserLogin.BrowserLoginConnectionSchema,
        value: { ...connection, port: 5_951.5 },
      },
      {
        name: 'blank password',
        schema: browserLogin.BrowserLoginConnectionSchema,
        value: { ...connection, password: ' ' },
      },
      {
        name: 'blank SSH tunnel',
        schema: browserLogin.BrowserLoginConnectionSchema,
        value: { ...connection, sshTunnel: ' ' },
      },
      {
        name: 'timezone-free open instant',
        schema: browserLogin.BrowserLoginStatusSchema,
        value: { ...openStatus, openedAt: '2026-07-31T12:00:00' },
      },
      { name: 'blank error', schema: browserLogin.BrowserLoginStatusSchema, value: { ...openStatus, error: ' ' } },
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
