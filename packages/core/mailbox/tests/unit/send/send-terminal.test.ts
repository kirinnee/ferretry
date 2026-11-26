import { describe, expect, test } from 'bun:test';
import type { FerretHarness, FerretsApi, HarnessDeliveryFailure } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ApiError } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { Unconfirmed } from '../../../contract/index.ts';
import { harnessSendTerminal } from '../../../daemon/send-terminal.ts';
import { SessionSendError } from '../../../daemon/lib/delivery/mounts/session-send.ts';
import {
  SendComposerOccupied,
  SendComposerUnreadable,
  SendLandingUnconfirmed,
  SendPaneNotReady,
} from '../../../contract/index.ts';
import { parseSessionId } from '../../../contract/index.ts';

const ID = parseSessionId(ferretId('f1'));
const seamOf = (harness: Partial<FerretHarness> | undefined): Pick<FerretsApi, 'harness'> => ({
  harness: async () => harness as FerretHarness | undefined,
});
const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('send path: the send terminal over the harness seam', () => {
  test('observe passes what the runner read, optional words only when there are some', async () => {
    const bare = harnessSendTerminal(
      seamOf({ observe: async () => ok({ alive: true, dead: false, promptReady: true, activeWork: false }) }),
    );
    expect(await bare.observe(ID)).toEqual({ alive: true, dead: false, promptReady: true, activeWork: false });
    const full = harnessSendTerminal(
      seamOf({
        observe: async () =>
          ok({
            alive: true,
            dead: false,
            promptReady: false,
            activeWork: true,
            compacting: true,
            startupParked: true,
            blockingPrompt: 'a dialog',
            draft: 'half',
          }),
      }),
    );
    expect(await full.observe(ID)).toEqual({
      alive: true,
      dead: false,
      promptReady: false,
      activeWork: true,
      compacting: true,
      startupParked: true,
      blockingPrompt: 'a dialog',
      draft: 'half',
    });
  });

  test('a pane that is not there reads as not alive (a send to it becomes a revive); any other refusal is thrown, never read as fine', async () => {
    const gone = harnessSendTerminal(seamOf({ observe: async () => err({ refused: 'no_pane' }) }));
    expect(await gone.observe(ID)).toEqual({ alive: false, dead: false, promptReady: false, activeWork: false });
    const held = harnessSendTerminal(seamOf({ observe: async () => err({ refused: 'input_pending' }) }));
    expect(await rejection(held.observe(ID))).toMatchObject({ status: 409, code: 'input_pending' });
  });

  test('heldAt answers where the pane holds the message, and throws a refusal or an unreadable pane (never "not held")', async () => {
    const queue = harnessSendTerminal(seamOf({ heldAt: async () => ok('queue') }));
    expect(await queue.heldAt(ID, 'x')).toBe('queue');
    const refused = harnessSendTerminal(seamOf({ heldAt: async () => err({ refused: 'plugin_unavailable' }) }));
    expect(await rejection(refused.heldAt(ID, 'x'))).toMatchObject({ code: 'plugin_unavailable' });
    const unreadable = harnessSendTerminal(
      seamOf({
        heldAt: async () => {
          throw new Error('the queue runs past the pane');
        },
      }),
    );
    expect(await rejection(unreadable.heldAt(ID, 'x'))).toBeInstanceOf(Error);
  });

  test('the composer acts answer the runner’s outcome and say a refusal as the send route does', async () => {
    const acts = harnessSendTerminal(
      seamOf({
        clearComposer: async () => ok('foreign'),
        submitComposer: async (_text, strict) => ok(strict === true ? 'holding' : 'submitted'),
      }),
    );
    expect(await acts.clearComposer(ID, 'x')).toBe('foreign');
    expect(await acts.submitComposer(ID, 'x')).toBe('submitted');
    expect(await acts.submitComposer(ID, 'x', true)).toBe('holding');
    const refused = harnessSendTerminal(
      seamOf({
        clearComposer: async () => err({ refused: 'not_ready', why: 'exited' }),
        submitComposer: async () => err({ unconfirmed: true, stranded: true }),
      }),
    );
    expect(await rejection(refused.clearComposer(ID, 'x'))).toBeInstanceOf(SessionSendError);
    expect(await rejection(refused.submitComposer(ID, 'x'))).toBeInstanceOf(Unconfirmed);
  });

  test('stopActiveTurn answers the pane read after the stop, an absent pane when none could be read, and throws a refusal', async () => {
    const read = harnessSendTerminal(
      seamOf({ stopActive: async () => ok({ alive: true, dead: false, promptReady: true, activeWork: false }) }),
    );
    expect(await read.stopActiveTurn(ID)).toMatchObject({ promptReady: true });
    const unread = harnessSendTerminal(seamOf({ stopActive: async () => ok(undefined) }));
    expect(await unread.stopActiveTurn(ID)).toMatchObject({ alive: false });
    const held = harnessSendTerminal(seamOf({ stopActive: async () => err({ refused: 'held' }) }));
    expect(await rejection(held.stopActiveTurn(ID))).toMatchObject({ status: 409, code: 'held' });
  });

  test('a runner that offers none of it is plugin_unavailable for every member, never a guess', async () => {
    const off = harnessSendTerminal(seamOf({}));
    for (const call of [
      () => off.observe(ID),
      () => off.stopActiveTurn(ID),
      () => off.heldAt(ID, 'x'),
      () => off.clearComposer(ID, 'x'),
      () => off.submitComposer(ID, 'x'),
    ])
      expect(await rejection(call())).toMatchObject({ status: 503, code: 'plugin_unavailable' });
  });

  test('BG-052 the tracker’s retype: deliver types through the harness, and queue answers what the pane proved', async () => {
    const typed: string[] = [];
    const queued: string[] = [];
    const outcome: { value: 'held' | 'left' | 'typed' } = { value: 'held' };
    const terminal = harnessSendTerminal(
      seamOf({
        deliver: async delivery => {
          typed.push(delivery.text);
          return ok('turn-started');
        },
        queue: async text => {
          queued.push(text);
          return ok(outcome.value);
        },
      }),
    );

    await terminal.deliver(ID, 'FIXTURE again');
    expect(typed).toEqual(['FIXTURE again']);
    expect(await terminal.queue(ID, 'FIXTURE held')).toBe('held');
    outcome.value = 'left';
    expect(await terminal.queue(ID, 'FIXTURE left')).toBe('unproven');
    outcome.value = 'typed';
    expect(await rejection(terminal.queue(ID, 'FIXTURE stuck'))).toBeInstanceOf(SendLandingUnconfirmed);
    expect(queued).toEqual(['FIXTURE held', 'FIXTURE left', 'FIXTURE stuck']);
  });

  test('BG-052 a retype that fails says what the send service reads: nothing typed (a refusal) or typed and not proven', async () => {
    const failing = (failure: HarnessDeliveryFailure) =>
      harnessSendTerminal(seamOf({ deliver: async () => err(failure), queue: async () => err(failure) }));
    const cases: readonly [HarnessDeliveryFailure, new (...args: never[]) => Error][] = [
      [{ unconfirmed: true, stranded: false }, SendLandingUnconfirmed],
      [{ unconfirmed: true, stranded: true }, SendLandingUnconfirmed],
      [{ refused: 'composer_occupied', draft: 'FIXTURE draft' }, SendComposerOccupied],
      [{ refused: 'composer_unreadable' }, SendComposerUnreadable],
      [{ refused: 'not_ready', why: 'busy' }, SendPaneNotReady],
    ];
    for (const [failure, kind] of cases) {
      expect(await rejection(failing(failure).deliver(ID, 'x'))).toBeInstanceOf(kind);
      expect(await rejection(failing(failure).queue(ID, 'x'))).toBeInstanceOf(kind);
    }
    expect(
      await rejection(failing({ refused: 'composer_occupied', draft: 'FIXTURE draft' }).deliver(ID, 'x')),
    ).toMatchObject({ draft: 'FIXTURE draft' });
    expect(await rejection(failing({ refused: 'not_ready', why: 'dialog' }).deliver(ID, 'x'))).toMatchObject({
      why: 'dialog',
    });
    // Any other refusal is the seam's own answer (a hold, a runner that is off).
    expect(await rejection(failing({ refused: 'input_pending' }).deliver(ID, 'x'))).toMatchObject({
      status: 409,
      code: 'input_pending',
    });
    expect(await rejection(failing({ refused: 'plugin_unavailable' }).queue(ID, 'x'))).toMatchObject({
      status: 503,
      code: 'plugin_unavailable',
    });
  });

  test('an unknown ferret is 404 and a Ferrets with no seam is plugin_unavailable', async () => {
    const unknown = harnessSendTerminal(seamOf(undefined));
    const error = await rejection(unknown.observe(ID));
    expect(error).toBeInstanceOf(SessionSendError);
    expect((error as SessionSendError).failure).toBe('not_found');
    const seamless = harnessSendTerminal({});
    const none = await rejection(seamless.observe(ID));
    expect(none).toBeInstanceOf(ApiError);
    expect((none as ApiError).code).toBe('plugin_unavailable');
  });

  describe('the typing hold at the write boundary', () => {
    const PANE = { alive: true, dead: false, promptReady: true, activeWork: false };
    /** A harness whose pane is quiet for `quietLooks` looks, then a person types; it records every write that went through. */
    const typingHarness = (quietLooks: number) => {
      const writes: string[] = [];
      let looks = 0;
      const harness: Partial<FerretHarness> = {
        observe: async () => ok(++looks > quietLooks ? { ...PANE, typing: true } : PANE),
        deliver: async ({ text, beforeWrite }) => {
          // The runner's own order: the readiness wait (the looks above happen in it), then the step, then the key.
          await beforeWrite?.();
          writes.push(`deliver:${text}`);
          return ok('turn-started');
        },
        queue: async text => (writes.push(`queue:${text}`), ok('held')),
        submitComposer: async text => (writes.push(`submit:${text}`), ok('submitted')),
      };
      return { terminal: harnessSendTerminal(seamOf(harness)), writes };
    };

    test("holds the daemon's own deliver, queue and Enter as the pane busy, and types nothing", async () => {
      for (const by of ['agent', 'daemon'] as const) {
        const { terminal, writes } = typingHarness(0);
        for (const write of [
          terminal.deliver(ID, 'x', by),
          terminal.queue(ID, 'x', by),
          terminal.submitComposer(ID, 'x', false, by),
        ])
          expect(await rejection(write)).toMatchObject({ why: 'busy' });
        expect(writes).toEqual([]);
      }
    });

    test('looks again at the write, after the readiness wait, so a hold that began during it is not missed', async () => {
      // One quiet look (a caller's pre-check), then a person types: the write boundary is the second look.
      const { terminal, writes } = typingHarness(1);
      expect((await terminal.observe(ID)).typing).toBeUndefined();

      expect(await rejection(terminal.deliver(ID, 'x', 'daemon'))).toBeInstanceOf(SendPaneNotReady);
      expect(writes).toEqual([]);
    });

    test("never holds a person's own write, or a write that names no sender", async () => {
      for (const by of ['human', undefined] as const) {
        const { terminal, writes } = typingHarness(0);
        await terminal.deliver(ID, 'a', by);
        await terminal.queue(ID, 'b', by);
        await terminal.submitComposer(ID, 'c', false, by);
        expect(writes).toEqual(['deliver:a', 'queue:b', 'submit:c']);
      }
    });

    test('lets the daemon write once the pane is quiet, and a pane that cannot be read decides nothing', async () => {
      const quiet = harnessSendTerminal(
        seamOf({
          observe: async () => ok(PANE),
          deliver: async ({ beforeWrite }) => (await beforeWrite?.(), ok('turn-started')),
        }),
      );
      await quiet.deliver(ID, 'x', 'daemon');
      const unreadable = harnessSendTerminal(
        seamOf({
          observe: async () => {
            throw new Error('no pane read');
          },
          submitComposer: async () => ok('submitted'),
        }),
      );
      expect(await unreadable.submitComposer(ID, 'x', false, 'daemon')).toBe('submitted');
    });
  });
});
