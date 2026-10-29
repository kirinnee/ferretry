/**
 * The one line a tunnel session's life earns in the daemon log (`docs/relay-protocol.md` §15).
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { DirectSessionEnd } from '../../../src/lib/relay/direct-carrier.ts';
import { describeDuration, describeTunnelSessionEnd, tunnelSessionLog } from '../../../src/lib/tunnel/session-log.ts';

const END: DirectSessionEnd = {
  by: 'peer',
  code: 1006,
  reason: '',
  durationMs: 723_400,
  lastFrameAgeMs: 400,
  bytesIn: 12_600,
  bytesOut: 2_200_000,
  proved: true,
};

describe('the tunnel session log', () => {
  it('should say who cut a session, what the code means, how long it lived and when it last heard anything', () => {
    // Act
    const line = describeTunnelSessionEnd(END);

    // Assert
    should(line).equal(
      '1006 by the browser side (no close frame — the connection was cut); after 12m 03s; last frame 400ms before; 12.3 KB in, 2.1 MB out; device proved',
    );
  });

  it('should quote a reason on one line, so a peer cannot forge a second log line through it', () => {
    // Act
    const line = describeTunnelSessionEnd({
      ...END,
      by: 'daemon',
      code: 4408,
      reason: 'no heartbeat\nfyd fake line',
      proved: false,
    });

    // Assert
    should(line).startWith('4408 by this daemon (no heartbeat answered in time, “no heartbeat fyd fake line”)');
    should(line).not.containEql('\n');
    should(line).endWith('no device proved');
  });

  it('should say there was no code when the daemon released the socket itself', () => {
    // Act
    const line = describeTunnelSessionEnd({
      ...END,
      by: 'daemon',
      code: undefined,
      reason: 'the daemon released this socket',
    });

    // Assert
    should(line).startWith('no code by this daemon (“the daemon released this socket”)');
  });

  it('should print a transfer under a kilobyte in plain bytes', () => {
    // Act
    const line = describeTunnelSessionEnd({ ...END, bytesIn: 512, bytesOut: 0 });

    // Assert
    should(line).containEql('512 B in, 0 B out');
  });

  it('should print a duration at the precision that matters for it', () => {
    // Assert
    should(describeDuration(-5)).equal('0ms');
    should(describeDuration(850)).equal('850ms');
    should(describeDuration(4_240)).equal('4.2s');
    should(describeDuration(3_723_000)).equal('1h 02m 03s');
  });

  it('should report an open and a close as milestones in the journal', () => {
    // Arrange
    const steps: Array<readonly [string, string | undefined]> = [];
    const log = tunnelSessionLog({ step: (what, detail) => steps.push([what, detail]) });

    // Act
    log.opened();
    log.closed({ ...END, code: 1001, reason: 'bye' });

    // Assert
    should(steps[0]).eql(['tunnel session opened', undefined]);
    should(steps[1]?.[0]).equal('tunnel session closed');
    should(steps[1]?.[1]).startWith('1001 by the browser side (going away');
  });
});
