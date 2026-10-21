/**
 * `cloudflared`: the argument vector with no slot for a token, the environment that carries it, the
 * remedy a reader can act on, and the log lines that say whether the edge is reached.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLOUDFLARED_ARGUMENTS,
  CLOUDFLARED_NOT_ON_PATH,
  cloudflaredOverrideRefusal,
  cloudflaredRemedy,
  CONNECTOR_TOKEN_VARIABLE,
  connectorEnvironment,
  connectorEvent,
} from '../../../src/lib/tunnel/connector.ts';
import { registered, unregistered } from './support.ts';

describe('the cloudflared connector', () => {
  it('should run exactly the §15 command, which has no place for a token', () => {
    should([...CLOUDFLARED_ARGUMENTS]).deepEqual(['tunnel', '--no-autoupdate', 'run', '--protocol', 'quic']);
    should(Object.isFrozen(CLOUDFLARED_ARGUMENTS)).be.true();
  });

  it('should hand the token over in the child’s TUNNEL_TOKEN and nothing else', () => {
    should(CONNECTOR_TOKEN_VARIABLE).equal('TUNNEL_TOKEN');
    should(connectorEnvironment('fake-connector-token')).deepEqual({ TUNNEL_TOKEN: 'fake-connector-token' });
  });

  it('should state the consequence and every remedy in one line, and that nothing is downloaded', () => {
    // Act
    const line = cloudflaredRemedy(CLOUDFLARED_NOT_ON_PATH.kind === 'absent' ? CLOUDFLARED_NOT_ON_PATH.reason : '');

    // Assert
    should(line.includes('\n')).be.false();
    should(line).match(/^cloudflared is not on this daemon’s PATH, so this daemon has no tunnel carrier/u);
    should(line).match(/brew install cloudflared/u);
    should(line).match(/FY_CLOUDFLARED/u);
    should(line).match(/never downloads it/u);
  });

  it('should name an override that names nothing runnable, rather than search instead', () => {
    should(cloudflaredOverrideRefusal('/opt/nothing')).deepEqual({
      kind: 'absent',
      reason: 'FY_CLOUDFLARED names /opt/nothing, which is not an executable file',
    });
  });

  it('should read registration as a set of edge connections, by index', () => {
    should(connectorEvent(registered(2))).deepEqual({ kind: 'registered', connection: '2' });
    should(connectorEvent(unregistered(2))).deepEqual({ kind: 'unregistered', connection: '2' });
    // A format without an index degrades to one connection rather than to "never registered".
    should(connectorEvent('INF Registered tunnel connection')).deepEqual({ kind: 'registered', connection: '0' });
    should(connectorEvent('INF Starting tunnel tunnelID=abc')).be.undefined();
  });
});
