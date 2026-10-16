/**
 * Whether a program on Codex's callback port may be stopped, and reading the tables that say who it is.
 *
 * The decision is the dangerous half: a false "this is a leftover Codex sign-in" stops somebody's proxy.
 * So every case that is NOT proven must answer false.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CallbackPortHolder,
  heldPortsWords,
  isCodexLoginCommand,
  isLeftoverCodexLogin,
  parseLsofListeners,
  parsePsLine,
  parseSsListeners,
} from '../../../src/lib/fleet-login/port-holders.ts';

const holder = (overrides: Partial<CallbackPortHolder> = {}): CallbackPortHolder => ({
  port: 1455,
  pid: 900,
  name: 'codex',
  uid: 501,
  commandLine: '/usr/local/bin/codex login',
  ...overrides,
});

describe('isCodexLoginCommand', () => {
  it('should recognise the shapes a Codex sign-in runs as', () => {
    // Assert — what this daemon launches, what a person types, and npm's launcher.
    should(isCodexLoginCommand('/opt/codex/codex -c cli_auth_credentials_store="file" login --device-auth')).be.true();
    should(isCodexLoginCommand('codex login')).be.true();
    should(isCodexLoginCommand('node /usr/lib/node_modules/@openai/codex/bin/codex.js login')).be.true();
  });

  it('should refuse anything that is not Codex running its login', () => {
    // Assert
    should(isCodexLoginCommand('nginx: master process /usr/sbin/nginx')).be.false();
    should(isCodexLoginCommand('/usr/local/bin/codex exec "login to the server"')).be.false();
    should(isCodexLoginCommand('login codex')).be.false();
    should(isCodexLoginCommand('/usr/bin/codexproxy login')).be.false();
  });
});

describe('isLeftoverCodexLogin', () => {
  it('should prove a Codex login run by this daemon’s own user', () => {
    should(isLeftoverCodexLogin(holder(), 501)).be.true();
  });

  it('should refuse every case it cannot prove', () => {
    // Assert — another user, an unknown user, no pid, no command line, and somebody else's program.
    should(isLeftoverCodexLogin(holder({ uid: 502 }), 501)).be.false();
    should(isLeftoverCodexLogin(holder({ uid: undefined }), 501)).be.false();
    should(isLeftoverCodexLogin(holder(), undefined)).be.false();
    should(isLeftoverCodexLogin(holder({ pid: undefined }), 501)).be.false();
    should(isLeftoverCodexLogin(holder({ commandLine: undefined }), 501)).be.false();
    should(isLeftoverCodexLogin(holder({ commandLine: 'caddy run' }), 501)).be.false();
  });
});

describe('heldPortsWords', () => {
  it('should name each program once, with its pid and every port it holds', () => {
    const nginx = holder({ name: 'nginx', pid: 4242 });
    should(
      heldPortsWords([
        { holder: nginx, verdict: 'not-codex' },
        { holder: { ...nginx, port: 1457 }, verdict: 'not-codex' },
        { holder: { ...nginx, port: 1457 }, verdict: 'not-codex' },
      ]),
    ).equal(
      'ports 1455 and 1457 are in use by "nginx" (pid 4242), which is not a Codex sign-in, so Ferretry will not stop it',
    );
  });

  it('should say a leftover that could not be stopped, and a program it may not name, apart', () => {
    should(
      heldPortsWords([
        { holder: holder({ pid: 900 }), verdict: 'could-not-stop' },
        { holder: holder({ port: 1457, name: 'a program run by another user', pid: undefined }), verdict: 'not-codex' },
      ]),
    ).equal(
      'port 1455 is in use by "codex" (pid 900), a leftover Codex sign-in Ferretry could not stop; port 1457 is in use by a program run by another user, which is not a Codex sign-in, so Ferretry will not stop it',
    );
  });
});

describe('parseLsofListeners', () => {
  it('should read each listener once, with its name and user, from field output', () => {
    // Arrange — one program on two addresses, then a second program, as `lsof -Fpcu` prints them.
    const output = ['p900', 'ccodex', 'u501', 'f7', 'p4242', 'cnginx', 'u0', 'p900', 'ccodex', 'u501', 'f8', ''].join(
      '\n',
    );

    // Act
    const actual = parseLsofListeners(output);

    // Assert
    should(actual).deepEqual([
      { pid: 900, name: 'codex', uid: 501 },
      { pid: 4242, name: 'nginx', uid: 0 },
    ]);
  });

  it('should keep a listener whose name and user it was not told, and ignore what it cannot read', () => {
    // Act
    const actual = parseLsofListeners(['cstray', 'uroot', 'p31', 'uwho', ''].join('\n'));

    // Assert
    should(actual).deepEqual([{ pid: 31, name: 'an unnamed program', uid: undefined }]);
    should(parseLsofListeners('')).deepEqual([]);
  });
});

describe('parseSsListeners', () => {
  it('should read every program on a row once, and an owner ss would not name as another user', () => {
    // Arrange
    const output = [
      'LISTEN 0 128 127.0.0.1:1455 0.0.0.0:* users:(("codex",pid=900,fd=7),("codex",pid=900,fd=8),("helper",pid=901,fd=3))',
      'LISTEN 0 128 [::1]:1455 [::]:*',
      '',
    ].join('\n');

    // Act
    const actual = parseSsListeners(output);

    // Assert
    should(actual).deepEqual([
      { pid: 900, name: 'codex' },
      { pid: 901, name: 'helper' },
      { pid: undefined, name: 'a program run by another user' },
    ]);
  });
});

describe('parsePsLine', () => {
  it('should split the user id from the whole command line', () => {
    should(parsePsLine('  501 /opt/codex/codex -c a=b login  \n')).deepEqual({
      uid: 501,
      commandLine: '/opt/codex/codex -c a=b login',
    });
  });

  it('should answer nothing for a program that has gone', () => {
    should(parsePsLine('')).be.undefined();
  });
});
