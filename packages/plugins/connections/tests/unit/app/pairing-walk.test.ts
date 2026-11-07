/**
 * First contact, through the production path: Connections' pairing walk (`app/pairing/walk.ts`) handed to the shell's
 * own `pair` port (`pairOverCarriers` → `pairOnLeg` → the shell's sealed session), against the REAL kernel session
 * layer and its pair mode. Only the network (`BrowserNetwork`) and the timers are scripted.
 */
import { describe, expect, test } from 'bun:test';
import {
  type PairDirectInput,
  PairingOutcomeUnknownError,
  type RelayCrypto,
  RelayPairingRefusedError,
  toBase64Url,
} from '@ferretry/app';
import { pairOverCarriers, WebCryptoRelayCrypto } from '@ferretry/app/testing';
import { AmbiguousPairingError, pairingCandidates, pairingWalk } from '../../../app/pairing/walk.ts';
import { PairingUnreachableError } from '../../../app/pairing/unreachable.ts';
import { BrowserNetwork, HandTimers, type ScriptedHost } from '../../support/browser-network.ts';
import { impostorDaemon, type KernelFixture, kernelFixture } from '../../support/kernel-session.ts';

const shellCrypto = new WebCryptoRelayCrypto();
const DIRECT = 'https://laptop.example.test';
const RELAY = 'https://relay.example';
const CODE = 'K7Q2-M9XW';

async function pairingInput(daemonId: string, address = DIRECT): Promise<PairDirectInput> {
  const minted = await shellCrypto.generateDeviceKey();
  return {
    address,
    daemonId,
    code: CODE,
    key: {
      deviceName: 'phone',
      publicKey: toBase64Url(minted.publicKeySpki),
      key: shellCrypto.deviceKeyHandle(minted.privateKey),
    },
  };
}

interface Run {
  readonly fx: KernelFixture;
  readonly network: BrowserNetwork;
  readonly timers: HandTimers;
  readonly pair: (input: PairDirectInput) => ReturnType<ReturnType<typeof pairOverCarriers>>;
}

/** `hosted`: the discovered rendezvous, or `null` for a document whose directory advertised none. */
async function walkOver(
  hosts: Record<string, ScriptedHost>,
  hosted: string | null = RELAY,
  crypto: RelayCrypto = shellCrypto,
): Promise<Run> {
  const fx = await kernelFixture();
  const network = new BrowserNetwork(fx, hosts);
  const timers = new HandTimers();
  const walk = pairingWalk({
    openSocket: network.openSocket,
    after: timers.after,
    hostedRelay: async () => hosted ?? undefined,
  });
  const noDirect = () => {
    throw new Error('the shell’s own direct dial is not used once Connections registered a walk');
  };
  return { fx, network, timers, pair: pairOverCarriers(crypto, noDirect, timers.after, () => walk) };
}

const hostOf = (url: string): string => new URL(url).host;

/** The browser's crypto, counting every key derivation, seal and signature it performs (R570). */
function countingCrypto(): { readonly crypto: RelayCrypto; readonly calls: Record<string, number> } {
  const calls: Record<string, number> = { deriveSharedSecret: 0, deriveKey: 0, seal: 0, signEd25519: 0 };
  const crypto = new Proxy(shellCrypto, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof name !== 'string' || !(name in calls) || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1;
        return (value as (...given: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { crypto, calls };
}
const bytesContain = (frames: readonly Uint8Array[], text: string): boolean =>
  frames.some(frame => new TextDecoder().decode(frame).includes(text));

describe('the daemon is proved before anything is sent', () => {
  for (const row of ['P24', 'R570', 'P135'])
    test(`${row} a daemon whose signed hello does not hash to the QR-pinned fingerprint is refused before any key, proof or code, on every leg`, async () => {
      // Arrange — both legs reach a HOSTILE daemon: it claims the pinned fingerprint and answers with a daemon hello
      // properly signed by its OWN identity, so only the browser's own pin check stands between it and the code.
      const impostor = await impostorDaemon();
      const counting = countingCrypto();
      const run = await walkOver(
        {
          [hostOf(DIRECT)]: { kind: 'impostor', answer: impostor.answer },
          [hostOf(RELAY)]: { kind: 'impostor', answer: impostor.answer },
        },
        RELAY,
        counting.crypto,
      );
      const input = await pairingInput(run.fx.daemonId);

      // Act
      const failure = await run.pair(input).catch((error: unknown) => error);

      // Assert — the walk tried both legs and refused to key either: each leg carried exactly one frame (the client
      // hello), no sealed record (no pair record, so no code and no device proof), and no shared secret or session key
      // was derived, nothing sealed and nothing signed by this browser.
      expect(failure).toBeInstanceOf(PairingUnreachableError);
      expect(run.network.dialled.map(url => new URL(url).host)).toEqual([hostOf(DIRECT), hostOf(RELAY)]);
      for (const host of [hostOf(DIRECT), hostOf(RELAY)]) {
        expect(run.network.sent.get(host)).toHaveLength(1);
        expect(run.network.records(host)).toEqual([]);
        expect(bytesContain(run.network.sent.get(host) ?? [], CODE)).toBe(false);
        expect(bytesContain(run.network.sent.get(host) ?? [], input.key.publicKey)).toBe(false);
      }
      expect(counting.calls).toEqual({ deriveSharedSecret: 0, deriveKey: 0, seal: 0, signEd25519: 0 });
      expect(run.fx.pair.attempts).toEqual([]);
      run.fx.layer.close();
    });

  test('P24 the pinned daemon is redeemed over its own address and answers which carrier carried it', async () => {
    const run = await walkOver({ [hostOf(DIRECT)]: { kind: 'carries', carrier: 'direct' } });
    const paired = await run.pair(await pairingInput(run.fx.daemonId));
    expect(paired).toMatchObject({ kind: 'paired', via: { kind: 'direct', address: DIRECT } });
    expect(run.fx.pair.attempts).toHaveLength(1);
    expect(run.network.dialled).toHaveLength(1);
    run.fx.layer.close();
  });
});

describe('the walk', () => {
  for (const row of ['R582', 'R633'])
    test(`${row} redemption walks direct first, always, then the one discovered rendezvous — never a tunnel or WebRTC`, async () => {
      const run = await walkOver({
        [hostOf(DIRECT)]: { kind: 'dead' },
        [hostOf(RELAY)]: { kind: 'carries', carrier: 'relay' },
      });
      const paired = await run.pair(await pairingInput(run.fx.daemonId));
      expect(paired.via).toEqual({ kind: 'relay', address: RELAY });
      expect(run.network.dialled.map(url => new URL(url).origin)).toEqual([
        'wss://laptop.example.test',
        'wss://relay.example',
      ]);
      // The candidate list is the same whatever anybody chose: no preference is consulted, no third kind exists.
      expect(pairingCandidates({ address: DIRECT, daemonId: run.fx.daemonId }, RELAY).map(c => c.kind)).toEqual([
        'direct',
        'relay',
      ]);
      run.fx.layer.close();
    });

  test('R582 a direct address that answers nothing is given up at its deadline and the rendezvous is tried', async () => {
    const run = await walkOver({
      [hostOf(DIRECT)]: { kind: 'silent' },
      [hostOf(RELAY)]: { kind: 'carries', carrier: 'relay' },
    });
    const pending = run.pair(await pairingInput(run.fx.daemonId));
    await new Promise(resolve => setTimeout(resolve, 5));
    run.timers.fire(4_000);
    expect((await pending).via.kind).toBe('relay');
    run.fx.layer.close();
  });

  test('R582 a fingerprint this protocol cannot address gets no carrier at all, not even the direct one', () => {
    expect(pairingCandidates({ address: DIRECT, daemonId: 'not-a-fingerprint' }, RELAY)).toEqual([]);
  });

  test('R582 a sealed refusal ends the walk: the same code is never carried to the next carrier', async () => {
    const run = await walkOver({
      [hostOf(DIRECT)]: { kind: 'carries', carrier: 'direct' },
      [hostOf(RELAY)]: { kind: 'carries', carrier: 'relay' },
    });
    run.fx.pair.redeem = async attempt => {
      run.fx.pair.attempts.push(attempt);
      return 'refused';
    };
    const failure = await run.pair(await pairingInput(run.fx.daemonId)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayPairingRefusedError);
    expect(failure).not.toBeInstanceOf(AmbiguousPairingError);
    expect(run.network.dialled).toHaveLength(1);
    run.fx.layer.close();
  });
});

describe('what a failed pairing says', () => {
  test('P29 a code sent and unanswered is said plainly; a later refusal warns a device may have been paired', async () => {
    // Direct carries the hello and the pair record, then drops; the relay then refuses the (spent) code.
    const run = await walkOver({
      [hostOf(DIRECT)]: { kind: 'carries', carrier: 'direct', dropAfterFrames: 2 },
      [hostOf(RELAY)]: { kind: 'carries', carrier: 'relay' },
    });
    run.fx.pair.redeem = async attempt => {
      run.fx.pair.attempts.push(attempt);
      return 'refused';
    };
    const failure = await run.pair(await pairingInput(run.fx.daemonId)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AmbiguousPairingError);
    expect(failure).toBeInstanceOf(RelayPairingRefusedError);
    expect((failure as Error).message).toContain('Check the daemon for a device you do not recognise');
    run.fx.layer.close();
  });

  test('P29 with no later answer at all, the unanswered attempt is reported as exactly that', async () => {
    const run = await walkOver({ [hostOf(DIRECT)]: { kind: 'carries', carrier: 'direct', dropAfterFrames: 2 } }, null);
    const failure = await run.pair(await pairingInput(run.fx.daemonId)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PairingOutcomeUnknownError);
    expect((failure as Error).message).toBe(
      'the pairing code reached the daemon, but the session ended before its answer arrived',
    );
    run.fx.layer.close();
  });

  test('P30 every leg failed: loopback named, relay reason given; with no relay discovered that is said too', async () => {
    const withRelay = await walkOver(
      { '127.0.0.1:8443': { kind: 'dead' }, [hostOf(RELAY)]: { kind: 'absent', code: 4404 } },
      RELAY,
    );
    const both = await withRelay
      .pair(await pairingInput(withRelay.fx.daemonId, 'https://127.0.0.1:8443'))
      .catch((error: unknown) => error);
    expect(both).toBeInstanceOf(PairingUnreachableError);
    expect((both as Error).message).toContain('"this computer itself"');
    expect((both as Error).message).toContain('is not connected to it right now');
    expect((both as Error).message).not.toContain('There was no relay to fall back to');
    withRelay.fx.layer.close();

    const noRelay = await walkOver({ [hostOf(DIRECT)]: { kind: 'dead' } }, null);
    const alone = await noRelay.pair(await pairingInput(noRelay.fx.daemonId)).catch((error: unknown) => error);
    expect((alone as Error).message).toContain('could not reach the machine directly at laptop.example.test');
    expect((alone as Error).message).toContain('There was no relay to fall back to');
    noRelay.fx.layer.close();
  });

  test('P31 failure sentences name a host and port only — never a path, so the fingerprint stays out', async () => {
    const run = await walkOver(
      { [hostOf(DIRECT)]: { kind: 'dead' }, [hostOf(RELAY)]: { kind: 'absent', code: 4429 } },
      RELAY,
    );
    const failure = await run.pair(await pairingInput(run.fx.daemonId)).catch((error: unknown) => error);
    const sentence = (failure as Error).message;
    expect(sentence).toContain('laptop.example.test');
    expect(sentence).toContain('relay.example');
    expect(sentence).not.toContain(run.fx.daemonId);
    expect(sentence).not.toContain('/v1/rendezvous');
    expect(sentence).not.toContain(CODE);
    run.fx.layer.close();
  });
});
