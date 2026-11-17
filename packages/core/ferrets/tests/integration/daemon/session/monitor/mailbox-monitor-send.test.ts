import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretId } from '../../../../../contract/index.ts';
import type { WakeDelivery, WakeReceipt } from '../../../../../contract/hooks/ferret-wake.hook.ts';
import { MailboxMonitorSend } from '../../../../../daemon/adapters/session/monitor/index.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import type { SessionSendService } from '../../../../../daemon/lib/session/peers/send.ts';

/**
 * A wake goes through the Mailbox when one provides `ferrets.wake`, keyed by the park's own key; only a daemon with no
 * Mailbox falls back to the harness seam, and a Mailbox that answered "no" is never second-guessed by the fallback.
 */

const ID = parseSessionId('20260806-wake');
const REQUEST = { id: ID, sendId: 'wake:20260806-wake:2026-08-01T11:00:00.000Z', message: 'your wait is over' };

function mailbox(receipt: WakeReceipt) {
  const calls: { ferret: FerretId; key: string; text: string }[] = [];
  const delivery: WakeDelivery = {
    wake: async (ferret, request) => {
      calls.push({ ferret, key: request.key, text: request.text });
      return receipt;
    },
  };
  return { delivery, calls };
}

function fallback() {
  const sent: unknown[] = [];
  const send: Pick<SessionSendService, 'send'> = {
    send: async request => {
      sent.push(request);
    },
  };
  return { send, sent };
}

describe('MailboxMonitorSend', () => {
  it('should hand the park key and the text to the provider and return when it accepts', async () => {
    const { delivery, calls } = mailbox({ kind: 'accepted', sendId: REQUEST.sendId, state: 'queued' });
    const harness = fallback();

    await new MailboxMonitorSend(() => delivery, harness.send).send(REQUEST);

    should(calls).eql([{ ferret: ID as unknown as FerretId, key: REQUEST.sendId, text: 'your wait is over' }]);
    should(harness.sent).eql([]);
  });

  it('should throw with the reason, and not use the fallback, when the provider refuses', async () => {
    const { delivery } = mailbox({ kind: 'refused', reason: 'the ferret is gone' });
    const harness = fallback();

    await new MailboxMonitorSend(() => delivery, harness.send)
      .send(REQUEST)
      .should.be.rejectedWith('the wake was not accepted: the ferret is gone');

    should(harness.sent).eql([]);
  });

  it('should call the harness fallback once and never a provider when nothing provides the wake', async () => {
    const harness = fallback();

    await new MailboxMonitorSend(() => 'unavailable', harness.send).send(REQUEST);

    should(harness.sent).eql([REQUEST]);
  });

  it('should use a provider that appears after the first call on the next send', async () => {
    const { delivery, calls } = mailbox({ kind: 'accepted', sendId: REQUEST.sendId, state: 'delivered' });
    const harness = fallback();
    let provided: WakeDelivery | 'unavailable' = 'unavailable';
    const send = new MailboxMonitorSend(() => provided, harness.send);

    await send.send(REQUEST);
    provided = delivery;
    await send.send(REQUEST);

    should(harness.sent).eql([REQUEST]);
    should(calls.map(call => call.key)).eql([REQUEST.sendId]);
  });
});
