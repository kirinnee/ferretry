import { expect, test } from 'bun:test';
import { type BrowserSocket, createBrowserRelayDial } from '../../../app/adapters/browser-relay-dial.ts';
function harness() {
  const sent: (string | ArrayBuffer)[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const closes: number[] = [];
  const socket: BrowserSocket = {
    binaryType: 'blob',
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: bytes => {
      sent.push(bytes);
    },
    close: code => {
      if (code !== undefined) closes.push(code);
    },
  };
  const dial = createBrowserRelayDial({
    openSocket: () => socket,
    after: (ms, run) => {
      timers.push({ ms, run });
    },
  });
  const adapted = dial('https://relay.example/v1/rendezvous/private-fingerprint/client');
  const ends: { code: number; reason: string }[] = [];
  adapted.onClose = (code, reason) => {
    ends.push({ code, reason });
  };
  return { socket, adapted, sent, timers, ends, closes };
}
test('R32 browser direct and relay sockets hand the session binary frames in order', () => {
  const h = harness();
  expect(h.socket.binaryType).toBe('arraybuffer');
  const heard: number[] = [];
  h.adapted.onBinary = bytes => {
    heard.push(bytes[0]!);
  };
  h.socket.onmessage!({ data: new Uint8Array([1]).buffer });
  h.socket.onmessage!({ data: new Uint8Array([2]).buffer });
  expect(heard).toEqual([1, 2]);
});
test('R199 a real close wins over error and code zero is never reported', () => {
  const h = harness();
  h.socket.onerror!();
  expect(h.ends).toHaveLength(0);
  h.socket.onclose!({ code: 4432, reason: 'capacity' });
  h.timers[0]!.run();
  expect(h.ends).toEqual([{ code: 4432, reason: 'capacity' }]);
  const zero = harness();
  zero.socket.onclose!({ code: 0, reason: '' });
  expect(zero.ends[0]?.code).toBe(1006);
  expect(zero.ends[0]?.reason).toContain('https://relay.example');
  expect(zero.ends[0]?.reason).not.toContain('private-fingerprint');
});
test('R199 an error without close ends after the copied 250 ms grace', () => {
  const h = harness();
  h.socket.onerror!();
  expect(h.timers[0]?.ms).toBe(250);
  h.timers[0]!.run();
  expect(h.ends[0]?.code).toBe(1006);
});
test('R43 unsupported browser message shapes close rather than enter the session', () => {
  const h = harness();
  h.socket.onmessage!({ data: { untrusted: true } });
  expect(h.closes).toEqual([4400]);
  expect(h.ends[0]?.code).toBe(4400);
});
