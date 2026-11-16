import { describe, expect, test } from 'bun:test';
import { decodeFrame, FRAME_KINDS } from '../../../host/session/wire/frames.ts';
import { SUITE_SESSION_ID, suiteFrame } from '../../../testing/index.ts';

describe('S the carrier suite sends valid wire frames', () => {
  test('a suite frame is the real 28-byte envelope plus its payload, a data frame for the suite session', () => {
    const bytes = suiteFrame(3, 'one');
    expect(bytes.byteLength).toBe(28 + 3);
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.frame.kind).toBe(FRAME_KINDS.data);
    expect(decoded.frame.sequence).toBe(3);
    expect(decoded.frame.sessionId).toEqual(SUITE_SESSION_ID);
    expect(new TextDecoder().decode(decoded.frame.payload)).toBe('one');
  });
});
