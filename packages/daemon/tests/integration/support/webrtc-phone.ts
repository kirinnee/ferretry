/**
 * A phone on WebRTC, against a daemon running in its own process: paired, inside its own session, with a
 * real libdatachannel peer CONNECTED to the daemon and its session channel open.
 *
 * Everything stays on loopback — the peer binds 127.0.0.1 and offers with no ICE server — so nothing
 * leaves the machine. The daemon must have been configured with `webrtc.iceServers: []` too, or its
 * answer would ask a public STUN server for this machine's address.
 *
 * The person at the machine first switches the unlock on opening off (only a host caller may loosen it),
 * because a passkey ceremony is not what any caller of this helper is measuring.
 */
import { readFile } from 'node:fs/promises';
import { PairingCodeMintResponseSchema, WEBRTC_SESSION_CHANNEL_LABEL } from '@ferretry/protocol';
import { PeerConnection } from 'node-datachannel';
import { deviceSession, newTestDevice, pairOverSession } from '../../support/session-client.ts';

export interface WebRtcPhone {
  /** From the offer leaving the phone to the daemon's answer arriving, in milliseconds. */
  readonly offerMs: number;
  /** From the offer leaving the phone to its session channel opening, in milliseconds. */
  readonly openMs: number;
  /** Hang up: the session and the peer. Safe after the daemon is gone. */
  close(): void;
}

/** Pairs a phone with the daemon at `base` (state home `home`) and connects it peer-to-peer. */
export async function dialWebRtc(base: string, home: string): Promise<WebRtcPhone> {
  const token = (await readFile(`${home}/api-token`, 'utf8')).trim();
  const host = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const loosened = await fetch(`${base}/v1/security`, {
    method: 'PATCH',
    headers: host,
    body: JSON.stringify({ unlockOnOpen: false }),
  });
  if (!loosened.ok) throw new Error(`the daemon kept the unlock on opening: ${String(loosened.status)}`);
  const minted = PairingCodeMintResponseSchema.parse(
    await (await fetch(`${base}/v1/pair/code`, { method: 'POST', headers: host })).json(),
  );
  const device = await newTestDevice();
  const paired = await pairOverSession(base, minted.daemonId, minted.code, 'WebRTC phone', device);
  if (paired.kind !== 'paired') throw new Error('the daemon refused a fresh pairing code');
  const session = await deviceSession(base, minted.daemonId, paired.response.deviceId, device);
  const peer = new PeerConnection('webrtc-phone', { iceServers: [], bindAddress: '127.0.0.1' });
  const hangUp = (): void => {
    session.close();
    try {
      peer.close();
    } catch {
      // Already gone with the daemon.
    }
  };
  try {
    const gathered = new Promise<void>(resolve =>
      peer.onGatheringStateChange(state => state === 'complete' && resolve()),
    );
    const channel = peer.createDataChannel(WEBRTC_SESSION_CHANNEL_LABEL);
    const opened = new Promise<void>(resolve => channel.onOpen(() => resolve()));
    await gathered;
    const offer = peer.localDescription();
    if (offer === null) throw new Error('the phone made no offer');
    const offered = performance.now();
    const answer = await session.request('POST', '/v1/webrtc/offer', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: offer.sdp }),
    });
    const offerMs = performance.now() - offered;
    if (answer.status !== 200) throw new Error(`the daemon refused the offer: ${String(answer.status)} ${answer.body}`);
    peer.setRemoteDescription((JSON.parse(answer.body) as { sdp: string }).sdp, 'answer');
    await opened;
    return { offerMs, openMs: performance.now() - offered, close: hangUp };
  } catch (error) {
    hangUp();
    throw error;
  }
}
