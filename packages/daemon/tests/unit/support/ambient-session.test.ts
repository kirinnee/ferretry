import { describe, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  AMBIENT_SESSION_VARIABLES,
  assertDisposable,
  PROTECTED_PATHS_VARIABLE,
  protectedPaths,
  shedAmbientSession,
  tmuxSocketOf,
} from '../../support/ambient-session.ts';

const USER_HOME = '/home/owner';
const REAL_HOME = '/home/owner/.ferretry';
const LIVE_SOCKET = '/home/owner/.ferretry/tmux.sock';

/** The environment an agent's pane hands a suite it starts. */
function agentPane(): Record<string, string | undefined> {
  return {
    PATH: '/usr/bin:/bin',
    FY_HOME: REAL_HOME,
    TMUX: `${LIVE_SOCKET},809560,12`,
    TMUX_PANE: '%12',
    FY_SESSION_ID: 'mvu0e879-9cf09fb8',
    FY_SESSION_TOKEN: 'fys_capability',
    FY_SESSION_BOARD_CAPABILITY: 'fys_capability',
    FY_PACK: '1',
  };
}

describe('shedding the agent session a suite was started from', () => {
  it('should remove every variable a pane carries and record the home and socket they named', () => {
    // Arrange
    const environment = agentPane();

    // Act
    const guarded = shedAmbientSession(environment, USER_HOME, tmpdir());

    // Assert
    for (const name of AMBIENT_SESSION_VARIABLES) should(environment).not.have.property(name);
    should(environment.PATH).equal('/usr/bin:/bin');
    should(guarded).containEql(REAL_HOME);
    should(guarded).containEql(LIVE_SOCKET);
    should(environment[PROTECTED_PATHS_VARIABLE]?.split(':')).containEql(LIVE_SOCKET);
  });

  it('should shed only once per process tree, never mistaking a test’s own FY_HOME for an inherited one', () => {
    // Arrange
    const environment = agentPane();
    shedAmbientSession(environment, USER_HOME, tmpdir());
    const fixtureHome = join(tmpdir(), 'fy-fixture-home');
    environment.FY_HOME = fixtureHome;

    // Act
    const guarded = shedAmbientSession(environment, USER_HOME, tmpdir());

    // Assert
    should(environment.FY_HOME).equal(fixtureHome);
    should(guarded).not.containEql(fixtureHome);
    should(guarded).containEql(REAL_HOME);
  });

  it('should protect the account’s default state home even when nothing was inherited', () => {
    // Arrange
    const environment: Record<string, string | undefined> = {};

    // Act
    const guarded = shedAmbientSession(environment, USER_HOME, tmpdir());

    // Assert
    should(guarded).deepEqual([REAL_HOME]);
  });

  it('should refuse to run when the temporary directory lies inside a protected home', () => {
    // Arrange
    const environment = agentPane();

    // Act
    const shed = () => shedAmbientSession(environment, USER_HOME, join(REAL_HOME, 'state', 'tmp'));

    // Assert
    should(shed).throw(/refusing to run tests: the temporary directory .* lies inside \/home\/owner\/\.ferretry/u);
  });
});

describe('what a teardown may touch', () => {
  const environment = { [PROTECTED_PATHS_VARIABLE]: `${REAL_HOME}:${LIVE_SOCKET}` };

  it('should allow a path strictly inside a temporary directory', () => {
    // Act
    const check = () =>
      assertDisposable(join(tmpdir(), 'fy-home-abc', 'state', 'tmux.sock'), 'a socket', environment, USER_HOME);

    // Assert
    should(check).not.throw();
  });

  it('should refuse the live server’s socket, the real home, and anything outside a temporary directory', () => {
    // Act
    const checks = [LIVE_SOCKET, REAL_HOME, '/home/owner/work/tmux.sock'].map(
      path => () => assertDisposable(path, 'a socket', environment, USER_HOME),
    );

    // Assert
    for (const check of checks)
      should(check).throw(/refusing to touch a socket .*: it is not inside a temporary directory/u);
  });

  it('should refuse a temporary root itself, a relative path, and a temporary path that holds a protected one', () => {
    // Arrange
    const holder = join(tmpdir(), 'fy-shielded');
    const shielded = join(holder, 'home');
    const guarded = { [PROTECTED_PATHS_VARIABLE]: shielded };

    // Act
    const temporaryRoot = () => assertDisposable('/tmp', 'a root', guarded, USER_HOME);
    const relative = () => assertDisposable('tmp/x', 'a root', guarded, USER_HOME);
    const holding = () => assertDisposable(holder, 'a root', guarded, USER_HOME);
    const inside = () => assertDisposable(join(shielded, 'tmux.sock'), 'a socket', guarded, USER_HOME);

    // Assert
    should(temporaryRoot).throw(/not inside a temporary directory/u);
    should(relative).throw(/not absolute/u);
    should(holding).throw(/is, holds or lies inside/u);
    should(inside).throw(/is, holds or lies inside/u);
  });
});

describe('the socket a TMUX value names', () => {
  it('should read the socket before the server pid, and nothing from a value that names none', () => {
    // Assert
    should(tmuxSocketOf(`${LIVE_SOCKET},809560,12`)).equal(LIVE_SOCKET);
    should(tmuxSocketOf(undefined)).be.undefined();
    should(tmuxSocketOf('relative,1,2')).be.undefined();
    should(protectedPaths({}, USER_HOME)).deepEqual([REAL_HOME]);
  });
});
