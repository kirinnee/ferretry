import { describe, it } from 'bun:test';
import should from 'should';
import { describeWebRtcEngine, type WebRtcEngineReport } from '../../../src/lib/webrtc/index.ts';

describe('describeWebRtcEngine', () => {
  it.each<[WebRtcEngineReport, string]>([
    [
      { kind: 'ready', library: 'libdatachannel 0.24.1', selfTestMs: 13.6 },
      'engine ready — libdatachannel 0.24.1; two local peers connected and echoed in 14 ms',
    ],
    [
      { kind: 'ready', library: 'libdatachannel 0.23.0', selfTestMs: 4.2 },
      'engine ready — libdatachannel 0.23.0; two local peers connected and echoed in 4 ms',
    ],
    [
      { kind: 'unavailable', reason: 'the WebRTC engine could not be loaded on linux-riscv64 (no addon)' },
      'engine unavailable — the WebRTC engine could not be loaded on linux-riscv64 (no addon); devices reach this ' +
        'daemon directly or through the relay instead',
    ],
  ])('should say what %j means for a device', (input, expected) => {
    // Act
    const actual = describeWebRtcEngine(input);

    // Assert
    should(actual).equal(expected);
  });
});
