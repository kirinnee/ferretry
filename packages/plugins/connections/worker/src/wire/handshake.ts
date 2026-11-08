/** Mirror of packages/core/kernel/host/session/wire/handshake.ts, byte-copied; replace with kernel export when approved. */
/**
 * The end-to-end handshake, identical on every carrier.
 *
 * Shape, in one line: ephemeral X25519 on both sides for forward secrecy, an Ed25519 signature by
 * the daemon over the whole transcript for identity, and the client's own credential sent only
 * afterwards, inside the encrypted channel. That is the TLS 1.3 arrangement, and it is chosen for
 * the same reason TLS chose it — a signed transcript is what stops a party in the middle from
 * splicing two halves of two different conversations together.
 *
 * What a rendezvous can do to this: nothing that helps it. It can drop the conversation, delay it,
 * or refuse to carry it. It cannot substitute a key, because the client checks the presented key
 * against the fingerprint the pairing QR gave it out of band. It cannot read the client credential,
 * because that never appears until after the channel is keyed. It cannot inject a byte, because
 * every record is authenticated under a key it cannot derive.
 *
 * What it can still see is stated plainly in the protocol document: who is talking to whom, when,
 * how often and how big each frame is.
 */
