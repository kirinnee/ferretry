/**
 * R2 and the previous-protocol half of R67: a `/1` peer meeting this `/2` daemon is told which side to update,
 * at the handshake, in words — there is no negotiation and nothing to downgrade to.
 */
import { describe, expect, test } from 'bun:test';
import {
  encodeHandshakeMessage,
  OLDER_APP_SENTENCE,
  PREVIOUS_SESSION_PROTOCOL_ID,
  SESSION_CLOSE_CODES,
  SESSION_PROTOCOL_ID,
  speaksPreviousSessionProtocol,
  startClientHandshake,
  utf8Bytes,
} from '../../../host/session/index.ts';
import { fixture, TestClient } from './harness.ts';
import { relayCrypto } from './identities.ts';

const previous = (hello: Record<string, unknown>): Record<string, unknown> => ({
  ...hello,
  protocol: PREVIOUS_SESSION_PROTOCOL_ID,
});

describe('a previous-protocol peer is told which side is old', () => {
  test('R2 a /1 hello ends 4426 with the sentence naming the app, and nothing is negotiated or answered', async () => {
    const fx = await fixture();
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId, previous);
    expect(client.end).toEqual({ code: SESSION_CLOSE_CODES.versionUnsupported, reason: OLDER_APP_SENTENCE });
    expect(client.end?.code).toBe(4426);
    expect(OLDER_APP_SENTENCE).toMatch(/\bapp\b.*older/u);
    // No handshake answer, no keys, no record: the daemon offered nothing to downgrade to.
    expect(client.handshakeSequence).toBeUndefined();
    expect(client.channel).toBeUndefined();
    expect(client.records).toHaveLength(0);
    expect(fx.requests).toHaveLength(0);
  });

  test('R2 the dialect that the daemon speaks is the one it answers, and /1 is a different identifier', () => {
    expect(PREVIOUS_SESSION_PROTOCOL_ID).toBe('ferretry-relay/1');
    expect(SESSION_PROTOCOL_ID).toBe('ferretry-relay/2');
    expect(OLDER_APP_SENTENCE).not.toContain('older Ferretry');
  });

  test('R67 a daemon receiving an hs1 naming /1 ends 4426 and says the app is older, on every carrier', async () => {
    const fx = await fixture();
    for (const carrier of ['relay', 'direct', 'tunnel', 'webrtc']) {
      const client = TestClient.open(fx, carrier);
      await client.handshake(fx.daemonId, previous);
      expect(client.end).toEqual({ code: 4426, reason: OLDER_APP_SENTENCE });
    }
  });

  test('R67 only the protocol field is read: any other unreadable hello is still 4400 unparseable, and an ordinary /2 hello is untouched', async () => {
    const fx = await fixture();
    const other = TestClient.open(fx);
    await other.handshake(fx.daemonId, hello => ({ ...hello, protocol: 'unknown-wire' }));
    expect(other.end).toEqual({ code: 4400, reason: 'unparseable client hello' });
    const broken = TestClient.open(fx);
    await broken.handshake(fx.daemonId, hello => ({ ...hello, epk: 'short' }));
    expect(broken.end).toEqual({ code: 4400, reason: 'unparseable client hello' });
    const fine = TestClient.open(fx);
    await fine.handshake(fx.daemonId);
    expect(fine.end).toBeUndefined();
    expect(fine.channel).toBeDefined();
  });

  test('R67 speaksPreviousSessionProtocol answers that one question and accepts nothing', async () => {
    const pending = await startClientHandshake(relayCrypto, TestClient.open(await fixture()).sessionId, 'fy_daemon_x');
    expect(speaksPreviousSessionProtocol(encodeHandshakeMessage(pending.hello))).toBe(false);
    expect(speaksPreviousSessionProtocol(utf8Bytes(JSON.stringify(previous({ ...pending.hello }))))).toBe(true);
    expect(speaksPreviousSessionProtocol(utf8Bytes(JSON.stringify({ protocol: PREVIOUS_SESSION_PROTOCOL_ID })))).toBe(
      true,
    );
    expect(speaksPreviousSessionProtocol(utf8Bytes('null'))).toBe(false);
    expect(speaksPreviousSessionProtocol(utf8Bytes('"ferretry-relay/1"'))).toBe(false);
    expect(speaksPreviousSessionProtocol(utf8Bytes('not json'))).toBe(false);
    expect(speaksPreviousSessionProtocol(new Uint8Array([0xff, 0xfe]))).toBe(false);
  });
});
