import { describe, it } from 'bun:test';
import should from 'should';
import { webrtcSelftest } from '../../../daemon/adapters/webrtc/selftest.ts';
import { clock } from '../../support/io.ts';

describe('the webrtc selftest `fyd --check` runs, with the real native engine', () => {
  it('R689 should print the sentence the release smoke judges: engine ready, from two loopback peers', async () => {
    // Act
    const actual = await webrtcSelftest.run({ tempDir: '/nowhere', signal: new AbortController().signal, clock });

    // Assert
    should(actual).match(/^engine ready — libdatachannel \d+\.\d+\.\d+/u);
  });
});
