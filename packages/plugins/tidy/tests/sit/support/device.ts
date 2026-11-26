import {
  completeClientHandshake,
  decodeDaemonHello,
  decodeFrame,
  deviceAuthMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  openChannel,
  openRecord,
  sealRecord,
  SESSION_PROTOCOL_ID,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  WebCryptoSessionCrypto,
  type SessionFrame,
} from '@ferretry/kernel/session';

/** A real paired device over the production direct carrier and sealed-session codec. No admission stand-in. */
export async function deviceClient(url: string, daemon: string, device: string, key: CryptoKey) {
  const codec = new WebCryptoSessionCrypto();
  const socket = new WebSocket(`${url.replace(/^http/u, 'ws')}/v1/rendezvous/${daemon}/client`);
  socket.binaryType = 'arraybuffer';
  const inbox: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  socket.onmessage = event => {
    if (typeof event.data === 'string') return;
    inbox.push(new Uint8Array(event.data as ArrayBuffer));
    wake?.();
  };
  socket.onclose = () => {
    ended = true;
    wake?.();
  };
  const next = async (): Promise<SessionFrame> => {
    while (inbox.length === 0) {
      if (ended) throw new Error('the synthetic device session closed');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          wake = undefined;
          reject(new Error('device response timed out'));
        }, 5000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
    const bytes = inbox.shift();
    if (bytes === undefined) throw new Error('missing frame');
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) throw new Error(decoded.reason);
    return decoded.frame;
  };
  try {
    const ready = await next();
    const pending = await startClientHandshake(codec, ready.sessionId, daemon);
    socket.send(
      new Uint8Array(
        encodeFrame({
          kind: FRAME_KINDS.handshake,
          sessionId: ready.sessionId,
          sequence: 0,
          payload: encodeHandshakeMessage(pending.hello),
        }),
      ),
    );
    let hello = await next();
    while (hello.kind === FRAME_KINDS.credit) hello = await next();
    const decoded = decodeDaemonHello(hello.payload);
    if (decoded === null) throw new Error('missing daemon hello');
    const complete = await completeClientHandshake(codec, pending, decoded);
    if (!complete.ok) throw new Error(complete.reason);
    let channel = openChannel(ready.sessionId, complete.keys, 'client');
    const send = async (record: unknown) => {
      const sealed = await sealRecord(codec, channel, utf8Bytes(JSON.stringify(record)));
      if (!sealed.ok) throw new Error(sealed.reason);
      channel = sealed.state;
      socket.send(new Uint8Array(encodeFrame(sealed.frame)));
    };
    const receive = async () => {
      let frame = await next();
      while (frame.kind === FRAME_KINDS.credit) frame = await next();
      const opened = await openRecord(codec, channel, frame);
      if (!opened.ok) throw new Error(opened.reason);
      channel = opened.state;
      return JSON.parse(new TextDecoder().decode(opened.plaintext)) as { t: string; status?: number; body?: string };
    };
    const appSession = toBase64Url(codec.randomBytes(16));
    const proof = await codec.signEd25519(
      codec.deviceKeyHandle(key),
      deviceAuthMessage(complete.keys.transcriptHash, 'auth', device, appSession),
    );
    await send({ t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceId: device, appSession, proof: toBase64Url(proof) });
    if ((await receive()).t !== 'authenticated') throw new Error('device authentication refused');
    let sequence = 0;
    return {
      close: () => socket.close(),
      request: async (method: string, path: string, body?: unknown) => {
        await send({
          t: 'req',
          id: ++sequence,
          method,
          path,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const response = await receive();
        if (response.t !== 'res') throw new Error('missing request response');
        return response;
      },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}
