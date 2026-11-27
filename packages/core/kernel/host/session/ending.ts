/** The final keyed record, pulled once before constant carrier teardown (relay protocol §7). */
import type { SealedFrame, SessionEnd } from '../../contract/session.ts';
import { sealRecord, type ChannelState } from './wire/channel.ts';
import type { SessionCrypto } from './wire/crypto.ts';
import { encodeFrame } from './wire/frames.ts';
import { SESSION_PROTOCOL_ID } from './wire/constants.ts';
import { encodeDaemonRecord } from './wire/records.ts';
import { RELAY_SESSION_CONCLUDED_CLOSE_CODE, RELAY_SESSION_CONCLUDED_CLOSE_REASON } from './wire/vocabulary.ts';

export class SessionEnding {
  readonly carrier: SessionEnd;
  #pending = false;
  #frame: SealedFrame | undefined;

  constructor(
    private readonly end: SessionEnd,
    private readonly channel: ChannelState | undefined,
    private readonly crypto: SessionCrypto,
  ) {
    this.carrier =
      channel === undefined
        ? end
        : {
            code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
            reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
          };
  }

  /** Serialize after any discarded seal; only a committed pull spent the previous sequence. */
  sealAfter(previous: Promise<void>, maySend: boolean, gone: () => boolean, ready: () => void): Promise<void> {
    const channel = this.channel;
    if (channel === undefined || !maySend) return previous;
    this.#pending = true;
    return (
      previous
        .then(async () => {
          try {
            if (gone()) return;
            const sealed = await sealRecord(
              this.crypto,
              channel,
              encodeDaemonRecord({ t: 'session-end', protocol: SESSION_PROTOCOL_ID, ...this.end }),
            );
            if (sealed.ok && !gone())
              this.#frame = { sequence: sealed.frame.sequence, bytes: encodeFrame(sealed.frame) };
          } finally {
            this.#pending = false;
            ready();
          }
        })
        // Without authenticated ciphertext the peer can establish only connection loss.
        .catch(() => undefined)
    );
  }

  next(): SealedFrame | SessionEnd | undefined {
    if (this.#pending) return undefined;
    const frame = this.#frame;
    this.#frame = undefined;
    return frame ?? this.carrier;
  }
}
