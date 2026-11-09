import { describe, expect, test } from 'bun:test';
import type { FerretHarness, FerretsApi } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ApiError } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { Unconfirmed } from '../../../daemon/harness-seam.ts';
import { harnessSendTerminal } from '../../../daemon/send-terminal.ts';
import { SessionSendError } from '../../../daemon/delivery/lib/mounts/session-send.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';

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

  test('typing is not carried here: deliver and queue refuse before any key', async () => {
    const terminal = harnessSendTerminal(seamOf({}));
    expect(await rejection(terminal.deliver(ID, 'x'))).toMatchObject({ code: 'conversation_terminal_unavailable' });
    expect(await rejection(terminal.queue(ID, 'x'))).toMatchObject({ code: 'conversation_terminal_unavailable' });
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
});
