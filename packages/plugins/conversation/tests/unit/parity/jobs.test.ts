/**
 * Parity rows J-* that Conversation owns (docs/design/rebuild-parity.tsv): today's timers and armed loops, and what
 * arms each now. Every timer here goes through the kernel clock. A loop that waits on a seam is `test.skip` naming the
 * seam; a row the parity owner rule placed here but that another plugin arms says so.
 */
import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { WorkerHandle } from '@ferretry/kernel/contract';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import { CONVERSATION_STATE, ConversationPort } from '../../../contract/index.ts';
import { decryptPdfInMemory, probePdfDecryptWorker } from '../../../daemon/attachments/adapters/decrypt-pdf.ts';
import { PdfDecryptError } from '../../../daemon/attachments/lib/index.ts';
import { SHARED_DRAFT_WRITE_DELAY_MS } from '../../../daemon/drafts/lib/index.ts';
import daemon from '../../../daemon/index.ts';
import { WORK_SEARCH_WARM_DELAY_MS } from '../../../daemon/search/index.ts';
import { memoryStatePort } from '../../support/state.ts';

const F1 = ferretId('f1');

/** The daemon half on the test host over a byte-keeping state, with the asks it lists counted. */
async function conversation() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1 });
  const asks = new FakeAsks();
  let listed = 0;
  const open = asks.open.bind(asks);
  asks.open = async (...args: Parameters<typeof open>) => {
    listed += 1;
    return await open(...args);
  };
  const state = memoryStatePort(CONVERSATION_STATE);
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks },
    clock: fixedClock('2026-11-07T09:00:00Z'),
  });
  return { host, state, listed: () => listed };
}

/** A clock that holds the one timer it is given, for the test to fire. */
let fire: (() => void) | undefined;
const catching = (_delay: unknown, run: () => void) => {
  fire = run;
  return () => undefined;
};
/** Fires the held timer; a function, so the checker does not narrow `fire` from the assignment before it. */
const fireTimer = (): void => fire?.();

/** A worker that never answers. */
const silent = (): WorkerHandle => ({
  post: () => undefined,
  onMessage: () => () => undefined,
  onExit: () => () => undefined,
  terminate: async () => {},
});

describe('the timers Conversation arms', () => {
  test('J-0201 the work search builds its index WORK_SEARCH_WARM_DELAY_MS after start, on the kernel clock', async () => {
    const { host, listed } = await conversation();
    await host.clock.advance(WORK_SEARCH_WARM_DELAY_MS - 1);
    await host.settle();
    expect(listed()).toBe(0);
    await host.clock.advance(1);
    await host.settle();
    await Bun.sleep(0);
    expect(listed()).toBeGreaterThan(0);
    await host.stop();
  });

  test('J-0183 J-0241 a shared draft is written SHARED_DRAFT_WRITE_DELAY_MS after it last changed', async () => {
    const { host, state } = await conversation();
    const api = host.provided(ConversationPort);
    const draft = await api.draft(F1);
    const edited = await api.editDraft(F1, 'chat', {
      generation: draft.generation,
      epoch: draft.epoch,
      base: draft.rev,
      text: ['hello'],
    });
    expect(edited.ok).toBe(true);
    const written = () => [...state.bytes.keys()].some(path => path.includes('f1'));
    expect(written()).toBe(false);
    await host.clock.advance(SHARED_DRAFT_WRITE_DELAY_MS);
    await host.settle();
    await Bun.sleep(0);
    expect(written()).toBe(true);
    await host.stop();
  });

  test('J-0149 a PDF unlock that hears nothing answers decryption_timeout when its timer fires', async () => {
    fire = undefined;
    const unlock = decryptPdfInMemory(
      { workers: { start: silent }, clock: { after: catching } },
      new Uint8Array([1]),
      'pw',
      { timeoutMs: 20_000 },
    );
    fireTimer();
    const refusal = await unlock.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PdfDecryptError);
    expect((refusal as PdfDecryptError).failure).toBe('decryption_timeout');
  });

  test('J-0167 the PDF worker probe says the worker did not start when its timer fires first', async () => {
    fire = undefined;
    const probe = probePdfDecryptWorker({ workers: { start: silent }, clock: { after: catching } }, { timeoutMs: 5 });
    fireTimer();
    expect(await probe).toMatchObject({ ready: false });
  });
});

describe('loops that wait on a seam', () => {
  test.skip('J-0074 queue delivery is armed — pending port: Ferrets deliver seam', () => {});
  test.skip('J-0076 send tracking is armed — pending port: Ferrets deliver seam', () => {});
  test.skip('J-0075 J-0139 the stranded-send reproof runs, and pauses between — pending port: Ferrets deliver seam', () => {});
  test.skip('J-0073 the turn observer is armed — pending port: Ferrets deliver seam', () => {});
  test.skip('J-0229 the queue deliverer schedules its next look — pending port: Ferrets deliver seam', () => {});
  test.skip('J-0202 J-0147 following a transcript that moved, and waking a waiting read — pending port: transcript seam', () => {});
  test.skip('J-0143 J-0144 the transcript conversion check’s spawn timers — pending port: transcript seam', () => {});
});

describe('rows the parity owner rule placed here that another plugin arms', () => {
  test.skip('J-0005 J-0116 the restart queue drain — not Conversation’s: ferrets', () => {});
  test.skip('J-0030 the fork queue — not Conversation’s: ferrets', () => {});
  test.skip('J-0049 J-0050 J-0051 catalog link reconcile, refresh and member sweeps — not Conversation’s: catalogs', () => {});
  test.skip('J-0083 the config files watcher — not Conversation’s: kernel', () => {});
  test.skip('J-0160 the write-behind queue of state writes — not Conversation’s: kernel', () => {});
});
