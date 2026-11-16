import { describe, it } from 'bun:test';
import { err, ok } from '@ferretry/std';
import should from 'should';
import type { FerretId } from '../../../../../contract/index.ts';
import type { FerretHarness, HarnessDeliveryFailure } from '../../../../../contract/port.ts';
import { FerretMonitorSend } from '../../../../../daemon/adapters/session/monitor/index.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * A wake goes through the harness seam: one delivery, the pane's own queue when the pane is at work, and a thrown failure
 * (never a retry, never a quoted screen) for everything else.
 */

const ID = parseSessionId('20260806-wake');
const REQUEST = { id: ID, sendId: 'wake:20260806-wake:2026-08-01T11:00:00.000Z', message: 'your wait is over' };

type Failure = HarnessDeliveryFailure;

function seam(deliver: () => ReturnType<FerretHarness['deliver']>, queue?: () => ReturnType<FerretHarness['queue']>) {
  const typed: string[] = [];
  const queued: { text: string; sendId: string | undefined }[] = [];
  const harness = {
    deliver: async (delivery: { text: string }) => {
      typed.push(delivery.text);
      return await deliver();
    },
    queue: async (text: string, options?: { sendId?: string }) => {
      queued.push({ text, sendId: options?.sendId });
      return await (queue ?? (async () => ok('held' as const)))();
    },
  } as unknown as FerretHarness;
  const asked: string[] = [];
  const send = new FerretMonitorSend(async (ferret: FerretId) => {
    asked.push(ferret);
    return harness;
  });
  return { send, typed, queued, asked };
}

const refused = (failure: Failure) => async () => err(failure);

describe('FerretMonitorSend', () => {
  it('should type the wake once and queue nothing when the pane takes it', async () => {
    const { send, typed, queued, asked } = seam(async () => ok('turn-started' as const));

    await send.send(REQUEST);

    should(asked).eql([ID]);
    should(typed).eql(['your wait is over']);
    should(queued).eql([]);
  });

  it('should put the wake in the pane’s own queue, keyed by the park, when the pane is at work', async () => {
    const { send, typed, queued } = seam(refused({ refused: 'not_ready', why: 'busy' }));

    await send.send(REQUEST);

    should(typed).eql(['your wait is over']);
    should(queued).eql([{ text: 'your wait is over', sendId: REQUEST.sendId }]);
  });

  it('should fail, naming only the closed reason, when the queue refuses too', async () => {
    const { send } = seam(refused({ refused: 'not_ready', why: 'busy' }), refused({ refused: 'plugin_unavailable' }));

    await send.send(REQUEST).then(
      () => should.fail('queued', undefined, 'resolved'),
      (error: Error) => should(error.message).equal('the wake was not queued: plugin_unavailable'),
    );
  });

  it('should fail and queue nothing for a refusal that is not "busy"', async () => {
    for (const failure of [
      { refused: 'not_ready', why: 'dialog' },
      { refused: 'composer_occupied', draft: 'private draft' },
      { refused: 'no_pane' },
    ] as const) {
      const { send, queued } = seam(refused(failure));
      await send.send(REQUEST).then(
        () => should.fail('typed', undefined, 'resolved'),
        (error: Error) => {
          should(error.message).startWith('the wake was not typed: ');
          should(error.message).not.match(/private draft/);
        },
      );
      should(queued).eql([]);
    }
  });

  it('should never type again a wake that was typed and not proven, and say so', async () => {
    const { send, typed, queued } = seam(refused({ unconfirmed: true, stranded: true }));

    await send.send(REQUEST).then(
      () => should.fail('typed', undefined, 'resolved'),
      (error: Error) => should(error.message).equal('the wake was not typed: unconfirmed'),
    );
    should(typed.length).equal(1);
    should(queued).eql([]);
  });

  it('should fail when the ferret is not held', async () => {
    const send = new FerretMonitorSend(async () => undefined);

    await send.send(REQUEST).then(
      () => should.fail('gone', undefined, 'resolved'),
      (error: Error) => should(error.message).match(/not held/),
    );
  });
});
