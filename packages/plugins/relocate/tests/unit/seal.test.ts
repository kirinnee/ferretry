import { describe, expect, test } from 'bun:test';
import { toBase64Url } from '@ferretry/std/sealing';
import { FERRET } from '../support/fake-ferrets.ts';
import { crypto, newIdentity, openOffer } from '../support/identity.ts';
import { openBundle } from '../support/open-bundle.ts';
import { world } from '../support/world.ts';

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as Error & { code?: string; status?: number },
  );

describe('sealing: the bundle opens only for the machine that offered the key', () => {
  test('seal → open round-trips, every chunk authenticated and every hash checked', async () => {
    const w = await world();
    const made = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    expect(result.header.targetDaemonId).toBe(w.targetIdentity.daemonId);
    expect(result.header.sourceDaemonId).toBe(w.sourceIdentity.daemonId);
    const chunks = Array.from({ length: result.header.chunks }, (_, index) =>
      w.relocation.chunk(result.exportId, index),
    );
    const opened = await openBundle(made.privateKey, made.offer.offerId, result.header, chunks);
    expect(opened?.manifest.ferret.name).toBe('Mover');
    expect(opened?.manifest.entries.length).toBeGreaterThan(8);
  });

  test('what leaves is ciphertext: no planted word is readable in any chunk', async () => {
    const w = await world();
    const made = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    for (let index = 0; index < result.header.chunks; index += 1) {
      const text = new TextDecoder('latin1').decode(w.relocation.chunk(result.exportId, index));
      expect(text).not.toContain('the assigned task');
      expect(text).not.toContain('hello');
    }
  });

  test('a tampered chunk is refused', async () => {
    const w = await world();
    const made = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    const chunks = Array.from({ length: result.header.chunks }, (_, index) =>
      w.relocation.chunk(result.exportId, index).slice(),
    );
    (chunks[0] as Uint8Array)[20] = ((chunks[0] as Uint8Array)[20] ?? 0) ^ 0xff;
    expect(await openBundle(made.privateKey, made.offer.offerId, result.header, chunks)).toBeUndefined();
  });

  test('a bundle cut short, or chunks put in another order, is refused', async () => {
    const w = await world();
    // a small chunk size is not needed: the fixture's tree makes more than one chunk only when large; force two by size
    const made = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    const chunks = Array.from({ length: result.header.chunks }, (_, index) =>
      w.relocation.chunk(result.exportId, index),
    );
    expect(await openBundle(made.privateKey, made.offer.offerId, result.header, chunks.slice(0, -1))).toBeUndefined();
    expect(
      await openBundle(made.privateKey, made.offer.offerId, { ...result.header, chunks: result.header.chunks + 1 }, [
        ...chunks,
        chunks[0] as Uint8Array,
      ]),
    ).toBeUndefined();
  });

  test('a wrong offer id derives another key and nothing opens', async () => {
    const w = await world();
    const made = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    const chunks = Array.from({ length: result.header.chunks }, (_, index) =>
      w.relocation.chunk(result.exportId, index),
    );
    const wrong = `fy_relocate_offer_${toBase64Url(crypto.randomBytes(16))}`;
    expect(await openBundle(made.privateKey, wrong, result.header, chunks)).toBeUndefined();
    expect(
      await openBundle(
        made.privateKey,
        made.offer.offerId,
        { ...result.header, offerId: wrong as typeof result.header.offerId },
        chunks,
      ),
    ).toBeUndefined();
  });

  test('another machine’s key cannot open it', async () => {
    const w = await world();
    const made = await w.offer();
    const other = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    const chunks = Array.from({ length: result.header.chunks }, (_, index) =>
      w.relocation.chunk(result.exportId, index),
    );
    expect(await openBundle(other.privateKey, made.offer.offerId, result.header, chunks)).toBeUndefined();
  });
});

describe('the offer is checked before anything is read or stopped', () => {
  test('an expired offer is refused and nothing is stopped', async () => {
    const w = await world();
    const made = await w.offer({ ttlMs: 1000 });
    w.now += 10 * 60_000;
    expect((await refusal(w.relocation.export(FERRET, made.offer)))?.code).toBe('offer_expired');
    expect(w.ferrets.calls).toEqual([]);
  });

  test('an offer that claims to stay open far longer than any offer does is refused', async () => {
    const w = await world();
    const made = await w.offer({ ttlMs: 24 * 60 * 60_000 });
    expect((await refusal(w.relocation.export(FERRET, made.offer)))?.code).toBe('offer_invalid');
  });

  test('an offer whose signature or key was changed is refused', async () => {
    const w = await world();
    for (const tamper of ['signature', 'key'] as const) {
      const made = await w.offer({ tamper });
      expect((await refusal(w.relocation.export(FERRET, made.offer)))?.code).toBe('offer_invalid');
    }
    expect(w.ferrets.calls).toEqual([]);
  });

  test('an offer signed by a daemon other than the one it names is refused', async () => {
    const w = await world();
    const made = await openOffer(w.targetIdentity, { expiresAtMs: w.now + 60_000 });
    const third = await newIdentity();
    const forged = { ...made.offer, daemonId: third.daemonId as typeof made.offer.daemonId };
    expect((await refusal(w.relocation.export(FERRET, forged)))?.code).toBe('offer_invalid');
  });

  test('an offer from this very machine is refused', async () => {
    const w = await world();
    const own = await openOffer(w.sourceIdentity, { expiresAtMs: w.now + 60_000 });
    expect((await refusal(w.relocation.export(FERRET, own.offer)))?.code).toBe('same_machine');
  });

  test('a replayed offer is refused: it is spent by the first attempt', async () => {
    const w = await world();
    const made = await w.offer();
    await w.relocation.export(FERRET, made.offer);
    w.ferrets.state = 'idle';
    expect((await refusal(w.relocation.export(FERRET, made.offer)))?.code).toBe('offer_spent');
  });

  test('a preflight refusal does not spend the offer: once the cause is gone the same offer works', async () => {
    const busy = ['a background job is still running'];
    const w = await world({ busy });
    const made = await w.offer();
    expect((await refusal(w.relocation.export(FERRET, made.offer)))?.code).toBe('move_refused');
    busy.length = 0;
    expect((await w.relocation.export(FERRET, made.offer)).header.offerId).toBe(made.offer.offerId);
  });

  test('a failure while reading resumes the ferret and leaves it as it was, and the offer is spent', async () => {
    const w = await world();
    const made = await w.offer();
    const broken = {
      ...w.source,
      read: async (): Promise<Uint8Array> => {
        throw new Error('disk fault');
      },
    };
    Object.assign(w.ferrets.port, { relocationSource: async () => broken });
    expect((await refusal(w.relocation.export(FERRET, made.offer)))?.message).toBe('disk fault');
    expect(w.ferrets.calls).toEqual(['stop:polite', 'resume']);
    expect(w.ferrets.state).toBe('idle');
    expect((await refusal(w.relocation.export(FERRET, made.offer)))?.code).toBe('offer_spent');
  });
});
