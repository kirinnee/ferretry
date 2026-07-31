import { describe, it } from 'bun:test';
import should from 'should';
import {
  FY_CLIENT_HEADER,
  FY_CLIENT_NAME,
  FY_DEFAULT_DAEMON_URL,
  FY_SESSION_ID_HEADER,
  resolveConnection,
} from '../../../src/lib/session/connection.ts';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';

describe('resolveConnection', () => {
  it('should resolve the address, token and CLI attribution', () => {
    // Arrange / Act
    const actual = resolveConnection({ url: ' http://127.0.0.1:9720 ', token: ' secret ' });

    // Assert
    should(actual.baseUrl).equal('http://127.0.0.1:9720');
    should(actual.token).equal('secret');
    should(actual.headers).deepEqual({ [FY_CLIENT_HEADER]: FY_CLIENT_NAME });
  });

  it('should attribute an in-pane caller to its own session', () => {
    // Arrange / Act
    const actual = resolveConnection({ url: 'http://d', token: 't', sessionId: ' ses-9 ' });

    // Assert
    should(actual.headers[FY_SESSION_ID_HEADER]).equal('ses-9');
  });

  it('should default to the local daemon when no address was exported', () => {
    // Arrange / Act
    const actual = resolveConnection({ token: 'secret' });

    // Assert
    should(actual.baseUrl).equal(FY_DEFAULT_DAEMON_URL);
  });

  it('should not claim a session for a blank id', () => {
    // Arrange / Act
    const actual = resolveConnection({ url: 'http://d', token: 't', sessionId: '   ' });

    // Assert
    should(actual.headers).not.have.property(FY_SESSION_ID_HEADER);
  });

  const missing: readonly (readonly [string, { url?: string; token?: string }, RegExp])[] = [
    ['no token', { url: 'http://d' }, /FY_TOKEN is not set/],
    ['a blank token', { url: 'http://d', token: ' ' }, /FY_TOKEN is not set/],
  ];

  for (const [name, input, expected] of missing) {
    it(`should refuse ${name} with an actionable message`, () => {
      // Arrange / Act
      const error = (() => {
        try {
          resolveConnection(input);
          return undefined;
        } catch (thrown) {
          return thrown;
        }
      })();

      // Assert
      should(error).be.instanceof(SessionCommandError);
      should((error as SessionCommandError).message).match(expected);
      // An unconfigured host is an environment problem, not a mistyped command.
      should((error as SessionCommandError).exitCode).equal(1);
    });
  }
});
