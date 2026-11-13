import { afterEach, describe, expect, it } from 'bun:test';
import {
  AGENDA_REPLY_CAP_MS,
  AGENDA_REPLY_COMPOSER_WAIT_MS,
  AGENDA_REPLY_RECHECK_MS,
  AGENDA_REPLY_SETTLE_MS,
} from '../../../daemon/lib/agenda/index.ts';
import { AskNotTypedError, type AskComposerState } from '../../../contract/index.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

/**
 * `AsksApi.tell` end to end over the real Asks half and its reply batch, on a clock the case drives: only the Vault's
 * view has it, and what it tells goes the way an owner's answer goes (settle window, composer wait, give-up).
 */
const FERRET = 'mvv6b4qw-49d0158d';
const ENDED =
  'A3 ended without a value (cancelled: owner declined). If you still need a value, raise a fresh terminal_request_input.';

const halves: Awaited<ReturnType<typeof asksHalf>>[] = [];
afterEach(async () => {
  for (const half of halves.splice(0)) await half.close();
});

/** A ferret that records what is typed into it and whose composer the case sets. */
function ferretWorld() {
  const typed: { ferret: string; message: string; sendId: string }[] = [];
  const composer: { state: AskComposerState; refuse: boolean } = { state: 'empty', refuse: false };
  const delivery = {
    send: async (ferret: string, message: string, sendId: string) => {
      if (composer.refuse) throw new AskNotTypedError('the composer holds unsent text');
      typed.push({ ferret, message, sendId });
    },
    composer: async () => composer.state,
  };
  return { typed, composer, delivery };
}

async function world() {
  const ferrets = ferretWorld();
  const half = await asksHalf({ 'ask.delivery:ferret': ferrets.delivery });
  halves.push(half);
  await half.start();
  /** Moves the clock in the batch's own recheck steps, letting each detached step finish. */
  const run = async (ms: number): Promise<void> => {
    for (let spent = 0; spent < ms; spent += AGENDA_REPLY_RECHECK_MS) {
      await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
      for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(1);
    }
  };
  return { half, run, ...ferrets };
}

describe('which plugin can tell a ferret something through Asks', () => {
  it('gives tell to the Vault’s view and to no other plugin’s, and a call through a cast finds nothing to call', async () => {
    const { half } = await world();
    expect(typeof half.asksFor('vault').tell).toBe('function');
    for (const id of ['accounts', 'tidy', 'ferrets', 'warden', 'conversation', 'board', 'agenda']) {
      const view = half.asksFor(id);
      expect('tell' in view).toBe(false);
      expect(typeof view.raise).toBe('function');
      const cast = view as unknown as { tell(f: string, t: string, s: string): Promise<unknown> };
      await expect((async () => await cast.tell(FERRET, 'type this', 'x'))()).rejects.toThrow(TypeError);
    }
  });
});

describe('telling a ferret through the Vault’s view', () => {
  it('queues the text and types it once, in the owner’s answer window, however often the same send id is asked', async () => {
    const { half, run, typed } = await world();
    const tell = half.asksFor('vault').tell;
    expect(await tell?.(FERRET, ENDED, 'input-ended-f-A3')).toBe('queued');
    expect(await tell?.(FERRET, ENDED, 'input-ended-f-A3')).toBe('known');
    await run(AGENDA_REPLY_SETTLE_MS - AGENDA_REPLY_RECHECK_MS);
    expect(typed).toEqual([]);
    await run(2 * AGENDA_REPLY_RECHECK_MS);
    expect(typed.map(each => each.message)).toEqual([ENDED]);
    expect(await tell?.(FERRET, ENDED, 'input-ended-f-A3')).toBe('known');
    await run(AGENDA_REPLY_CAP_MS);
    expect(typed.length).toBe(1);
  });

  it('refuses a text that is empty or too long and a ferret id that is none', async () => {
    const { half } = await world();
    const tell = half.asksFor('vault').tell;
    await expect(tell?.(FERRET, '', 'id')).rejects.toThrow();
    await expect(tell?.(FERRET, 'x'.repeat(4_097), 'id')).rejects.toThrow();
    await expect(tell?.('../escape', 'text', 'id')).rejects.toThrow();
    await expect(tell?.(FERRET, 'text', '')).rejects.toThrow();
  });

  it('drops a tell when the composer stays occupied past the wait: nothing typed, no timer left', async () => {
    const { half, run, typed, composer } = await world();
    composer.state = 'occupied';
    await half.asksFor('vault').tell?.(FERRET, ENDED, 'input-ended-f-A3');
    await run(AGENDA_REPLY_CAP_MS + AGENDA_REPLY_COMPOSER_WAIT_MS - AGENDA_REPLY_RECHECK_MS);
    expect(typed).toEqual([]);
    expect(half.clock.pending()).toBeGreaterThan(0);
    await run(2 * AGENDA_REPLY_RECHECK_MS);
    expect(typed).toEqual([]);
    expect(half.clock.pending()).toBe(0);
    // Dropped is gone for good: the composer emptying later types nothing, and the id may be told again.
    composer.state = 'empty';
    await run(AGENDA_REPLY_CAP_MS);
    expect(typed).toEqual([]);
    expect(await half.asksFor('vault').tell?.(FERRET, ENDED, 'input-ended-f-A3')).toBe('queued');
  });

  it('holds a tell for an unreadable composer exactly as it holds an answer, then types it when it empties', async () => {
    const { half, run, typed, composer } = await world();
    composer.state = 'unreadable';
    await half.asksFor('vault').tell?.(FERRET, ENDED, 'input-ended-f-A3');
    await run(AGENDA_REPLY_SETTLE_MS + 30_000);
    expect(typed).toEqual([]);
    composer.state = 'empty';
    await run(2 * AGENDA_REPLY_RECHECK_MS);
    expect(typed.map(each => each.message)).toEqual([ENDED]);
  });
});
