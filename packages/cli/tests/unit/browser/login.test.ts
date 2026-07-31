import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserLoginStatusSchema, renderLoginStatus } from '../../../src/lib/browser/login';

const CONNECTION = {
  host: '127.0.0.1',
  port: 5_901,
  password: 'one-shot',
  sshTunnel: 'ssh -N -L 5901:127.0.0.1:5901 person@host',
};

describe('the login status schema', () => {
  it('should accept a fully described open window', () => {
    // Act
    const actual = BrowserLoginStatusSchema.parse({
      state: 'open',
      profilePrimed: true,
      openedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
      connection: CONNECTION,
    });

    // Assert
    should(actual.state).equal('open');
    should(actual.connection?.port).equal(5_901);
  });

  it('should reject a response that never named a state', () => {
    // Act + Assert — a daemon that did not tell us is not a closed window.
    should(() => BrowserLoginStatusSchema.parse({ profilePrimed: false })).throw();
    should(() => BrowserLoginStatusSchema.parse({ state: 'ajar' })).throw();
  });

  it('should reject a connection missing the details needed to reach it', () => {
    // Act + Assert
    should(() => BrowserLoginStatusSchema.parse({ state: 'open', connection: { host: '127.0.0.1' } })).throw();
  });
});

describe('login rendering', () => {
  it('should print the state, timings, and priming', () => {
    // Act
    const actual = renderLoginStatus({
      state: 'open',
      profilePrimed: true,
      openedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
    });

    // Assert
    should(actual).containEql('browser login window: open');
    should(actual).containEql('opened 2026-01-01T00:00:00.000Z');
    should(actual).containEql('closes 2026-01-01T00:15:00.000Z');
    should(actual).containEql('profile primed: yes');
  });

  it('should say the priming is unknown when the daemon did not report it', () => {
    // Act — printing "no" here would claim a signed-in profile had been lost.
    const actual = renderLoginStatus({ state: 'closed' });

    // Assert
    should(actual).containEql('profile primed: unknown');
  });

  it('should say no when the daemon reported an unprimed profile', () => {
    // Act
    const actual = renderLoginStatus({ state: 'closed', profilePrimed: false });

    // Assert
    should(actual).containEql('profile primed: no');
  });

  it('should print the tunnel the daemon assembled rather than one built by hand', () => {
    // Act
    const actual = renderLoginStatus({ state: 'open', profilePrimed: false, connection: CONNECTION });

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
});
