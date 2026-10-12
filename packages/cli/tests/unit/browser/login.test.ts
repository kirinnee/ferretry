import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserLoginStatusSchema, renderLoginStatus } from '../../../src/lib/browser/login';

const CONNECTION = {
  host: '127.0.0.1',
  port: 5_901,
  password: 'one-shot',
  sshTunnel: 'ssh -N -L 5901:127.0.0.1:5901 person@host',
} as const;

const OPENED_AT = '2026-01-01T00:00:00.000Z';
const EXPIRES_AT = '2026-01-01T00:15:00.000Z';

describe('the login status schema', () => {
  it('should accept a fully described open window', () => {
    // Act
    const actual = BrowserLoginStatusSchema.parse({
      state: 'open',
      profilePrimed: true,
      openedAt: OPENED_AT,
      expiresAt: EXPIRES_AT,
      connection: CONNECTION,
    });

    // Assert
    should(actual.state).equal('open');
    should(actual.state === 'open' && actual.connection.port).equal(5_901);
  });

  it('should reject a response that never named a state', () => {
    // Act + Assert — a daemon that did not tell us is not a closed window.
    should(() => BrowserLoginStatusSchema.parse({ profilePrimed: false })).throw();
    should(() => BrowserLoginStatusSchema.parse({ state: 'ajar', profilePrimed: false })).throw();
  });

  it('should reject a connection missing the details needed to reach it', () => {
    // Act + Assert
    should(() =>
      BrowserLoginStatusSchema.parse({
        state: 'open',
        profilePrimed: false,
        openedAt: OPENED_AT,
        expiresAt: EXPIRES_AT,
        connection: { host: '127.0.0.1' },
      }),
    ).throw();
  });

  it('should reject a connection that points the viewer anywhere but loopback', () => {
    // Act — the VNC server only ever binds loopback, so any other host is a redirected viewer that
    // would be handed the one-shot password.
    const actual = BrowserLoginStatusSchema.safeParse({
      state: 'open',
      profilePrimed: true,
      openedAt: OPENED_AT,
      expiresAt: EXPIRES_AT,
      connection: { ...CONNECTION, host: '203.0.113.7' },
    });

    // Assert
    should(actual.success).be.false();
  });

  it('should reject a closed window that still carries a live password', () => {
    // Act
    const actual = BrowserLoginStatusSchema.safeParse({ state: 'closed', profilePrimed: true, connection: CONNECTION });

    // Assert
    should(actual.success).be.false();
  });

  it('should reject a status that does not say whether the profile is primed', () => {
    // Act
    const actual = BrowserLoginStatusSchema.safeParse({ state: 'closed' });

    // Assert
    should(actual.success).be.false();
  });
});

describe('login rendering', () => {
  it('should print the state, timings, and priming', () => {
    // Act
    const actual = renderLoginStatus({
      state: 'closing',
      profilePrimed: true,
      openedAt: OPENED_AT,
      expiresAt: EXPIRES_AT,
    });

    // Assert
    should(actual).containEql('browser login window: closing');
    should(actual).containEql(`opened ${OPENED_AT}`);
    should(actual).containEql(`closes ${EXPIRES_AT}`);
    should(actual).containEql('profile primed: yes');
  });

  it('should say no when the daemon reported an unprimed profile', () => {
    // Act
    const actual = renderLoginStatus({ state: 'closed', profilePrimed: false });

    // Assert
    should(actual).containEql('profile primed: no');
    should(actual).not.containEql('opened');
  });

  it('should print the tunnel the daemon assembled rather than one built by hand', () => {
    // Act
    const actual = renderLoginStatus({
      state: 'open',
      profilePrimed: false,
      openedAt: OPENED_AT,
      expiresAt: EXPIRES_AT,
      connection: CONNECTION,
    });

    // Assert
    should(actual).containEql('tunnel: ssh -N -L 5901:127.0.0.1:5901 person@host');
    should(actual).containEql('then point a VNC viewer at 127.0.0.1:5901');
    should(actual).containEql('password: one-shot');
  });

  it('should surface an error the daemon reported', () => {
    // Act
    const actual = renderLoginStatus({ state: 'error', profilePrimed: false, error: 'display unavailable' });

    // Assert
    should(actual).containEql('error: display unavailable');
  });

  it('should print no error line for an error state without a message', () => {
    // Act
    const actual = renderLoginStatus({ state: 'error', profilePrimed: false });

    // Assert
    should(actual).not.containEql('error:');
  });
});
