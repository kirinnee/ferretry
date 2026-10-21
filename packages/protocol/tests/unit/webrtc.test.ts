import { describe, it } from 'bun:test';
import should from 'should';
import {
  MAX_WEBRTC_SDP_BYTES,
  WEBRTC_CONNECT_DEADLINE_MS,
  WEBRTC_GATHER_CAP_MS,
  WEBRTC_GATHER_REFLEXIVE_GRACE_MS,
  WebRtcOfferAnswerSchema,
  WebRtcOfferRequestSchema,
} from '../../src/lib/webrtc.ts';

describe('the WebRTC offer and answer', () => {
  it.each([
    ['v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n', true],
    ['x'.repeat(MAX_WEBRTC_SDP_BYTES), true],
    ['x'.repeat(MAX_WEBRTC_SDP_BYTES + 1), false],
    // Counted in bytes, not characters: a multi-byte character cannot smuggle a larger SDP past the bound.
    ['é'.repeat(MAX_WEBRTC_SDP_BYTES / 2 + 1), false],
    ['', false],
  ])('should hold an SDP of %#th shape to the shared bound', (sdp, expected) => {
    // Act
    const offer = WebRtcOfferRequestSchema.safeParse({ sdp });
    const answer = WebRtcOfferAnswerSchema.safeParse({ sdp });

    // Assert
    should(offer.success).equal(expected);
    should(answer.success).equal(expected);
  });

  it('should refuse a key neither end defines, because both shapes are strict', () => {
    // Act
    const actual = WebRtcOfferRequestSchema.safeParse({ sdp: 'v=0', iceServers: ['turn:x'] });

    // Assert
    should(actual.success).be.false();
  });

  it('should keep the browser deadline longer than one side’s whole gathering bound', () => {
    // Assert — an attempt the clock abandons before the other end could even answer would never win.
    should(WEBRTC_CONNECT_DEADLINE_MS).be.above(WEBRTC_GATHER_CAP_MS * 2);
    should(WEBRTC_GATHER_CAP_MS).be.above(WEBRTC_GATHER_REFLEXIVE_GRACE_MS);
  });
});
