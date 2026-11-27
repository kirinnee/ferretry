import { describe, expect, test } from 'bun:test';
import type { WorkingTree } from '../../daemon/lib/git-bundle.ts';
import { plan } from '../../daemon/lib/snapshot.ts';
import { FERRET, fakeSource, summaryOf } from '../support/fake-ferrets.ts';
import { crypto } from '../support/identity.ts';
import { openBundle } from '../support/open-bundle.ts';
import { world } from '../support/world.ts';

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as Error & { code?: string; status?: number },
  );

describe('a bundle larger than one chunk is cut and still opens', () => {
  test('a 2.5 MiB attachment makes several chunks that round-trip and hash', async () => {
    const big = 'a'.repeat(2.5 * 1024 * 1024);
    const w = await world({ extra: { 'attachments/big.bin': big } });
    const made = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    expect(result.header.chunks).toBeGreaterThanOrEqual(3);
    const chunks = Array.from({ length: result.header.chunks }, (_, index) =>
      w.relocation.chunk(result.exportId, index),
    );
    const opened = await openBundle(made.privateKey, made.offer.offerId, result.header, chunks);
    expect(opened?.files.get('session:attachments/big.bin')?.length).toBe(big.length);
  });
});

describe('failures are sentences, and the ferret is never left stopped by a failed move', () => {
  test('an unknown export has no chunk and cannot be completed', async () => {
    const w = await world();
    expect(() => w.relocation.chunk('nope', 0)).toThrow('no such export');
    expect(
      (await refusal(w.relocation.complete('nope', { to: { daemonId: w.targetIdentity.daemonId, ferretId: 'x' } })))
        ?.code,
    ).toBe('export_unknown');
    const result = await w.relocation.export(FERRET, (await w.offer()).offer);
    expect(() => w.relocation.chunk(result.exportId, 99)).toThrow('no such chunk');
  });

  test('a machine that cannot read the ferret’s files for a move says so', async () => {
    const w = await world();
    Object.assign(w.ferrets.port, { relocationSource: async () => undefined });
    expect((await refusal(w.relocation.preflight(FERRET, w.targetIdentity.daemonId)))?.code).toBe('unavailable');
  });

  test('a source that fails while being looked at refuses the move with its sentence', async () => {
    const w = await world();
    Object.assign(w.ferrets.port, {
      relocationSource: async () => ({
        ...fakeSource(),
        files: async () => {
          throw new Error('the session folder could not be listed');
        },
      }),
    });
    const failed = await refusal(w.relocation.preflight(FERRET, w.targetIdentity.daemonId));
    expect(failed?.code).toBe('move_refused');
    expect(failed?.message).toBe('the session folder could not be listed');
    Object.assign(w.ferrets.port, {
      relocationSource: async () => ({
        ...fakeSource(),
        files: async () => {
          throw 'not an error';
        },
      }),
    });
    expect((await refusal(w.relocation.preflight(FERRET, w.targetIdentity.daemonId)))?.message).toBe(
      'the move could not be planned',
    );
  });

  test('a crypto failure while checking an offer is not taken for a refusal', async () => {
    const w = await world({
      crypto: Object.assign(Object.create(crypto), {
        verifyEd25519: async () => {
          throw new Error('crypto fault');
        },
      }) as typeof crypto,
    });
    expect((await refusal(w.relocation.export(FERRET, (await w.offer()).offer)))?.message).toBe('crypto fault');
    expect(w.ferrets.calls).toEqual([]);
  });

  test('a ferret that cannot be resumed after a failed export is logged, and the failure still reaches the caller', async () => {
    const w = await world();
    Object.assign(w.ferrets.port, {
      resume: async () => {
        throw new Error('no resume');
      },
      relocationSource: async () => ({
        ...fakeSource(),
        read: async () => {
          throw new Error('disk fault');
        },
      }),
    });
    expect((await refusal(w.relocation.export(FERRET, (await w.offer()).offer)))?.message).toBe('disk fault');
  });

  test('a sealing failure after the stop (a key no machine could hold) refuses and resumes', async () => {
    const w = await world({
      crypto: Object.assign(Object.create(crypto), { deriveSharedSecret: async () => null }) as typeof crypto,
    });
    expect((await refusal(w.relocation.export(FERRET, (await w.offer()).offer)))?.code).toBe('offer_invalid');
    expect(w.ferrets.calls).toEqual(['stop:polite', 'resume']);
  });
});

describe('a working tree that cannot be read is a refusal, not a crash', () => {
  const tree = (head: () => Promise<{ head: string }>, rest: Partial<WorkingTree>): WorkingTree => ({
    head,
    remote: async () => undefined,
    commits: async () => undefined,
    changes: async () => new Uint8Array(),
    untracked: async () => [],
    ignoredTopLevel: async () => [],
    size: async () => undefined,
    read: async () => undefined,
    ...rest,
  });
  const inputs = (t: WorkingTree) => ({ summary: summaryOf('idle'), source: fakeSource(), tree: t });

  test('an Error names its sentence; a thing that is not an Error gets the fixed one', async () => {
    const named = await plan(
      inputs(
        tree(async () => ({ head: 'a'.repeat(40) }), {
          untracked: async () => {
            throw new Error('git broke');
          },
        }),
      ),
    );
    expect(named.refusals).toContain('git broke');
    const unnamed = await plan(
      inputs(
        tree(async () => ({ head: 'a'.repeat(40) }), {
          ignoredTopLevel: async () => {
            throw 'odd';
          },
        }),
      ),
    );
    expect(unnamed.refusals).toContain('this ferret’s working tree could not be read');
  });
});
