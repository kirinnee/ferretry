import { describe, it } from 'bun:test';
import should from 'should';
import { CommandError } from '../../../cli/lib/errors.ts';
import { SendMessageController, WAIT_INTERVAL_MS } from '../../../cli/lib/send/controller.ts';
import type { SendGateway, SendWaitClock } from '../../../cli/lib/send/ports.ts';
import type { SendRecord, SendRequest, SendResult } from '../../../contract/index.ts';
import { at } from '../../support/instant.ts';

const result = (overrides: Partial<SendResult> = {}): SendResult =>
  ({ ferret: 'f1', disposition: 'delivered', sendId: 's1', ...overrides }) as SendResult;
const record = (fate: SendRecord['fate']): SendRecord =>
  ({ sendId: 's1', fate, acceptedAt: at('2026-11-06T09:00:00.000Z') }) as SendRecord;

function parts(
  options: { statuses?: (SendRecord | undefined)[]; result?: SendResult; parkFails?: boolean; after?: SendRecord } = {},
) {
  const sent: SendRequest[] = [];
  const parked: unknown[] = [];
  const lines: string[] = [];
  const statuses = [...(options.statuses ?? [])];
  let now = 0;
  const gateway: SendGateway = {
    send: async (_ferret, request) => {
      sent.push(request);
      return options.result ?? result();
    },
    sendStatus: async () => (statuses.length > 0 ? statuses.shift() : options.after),
    upload: async () => ({ id: 'a1' }),
    parkUntilReply: async (caller, details) => {
      if (options.parkFails) throw new Error('daemon said no');
      parked.push({ caller, ...details });
    },
  };
  const clock: SendWaitClock = {
    nowMs: () => now,
    sleep: async ms => {
      now += ms;
    },
  };
  const controller = (env: { callerFerret?: string } = {}) =>
    new SendMessageController(
      gateway,
      { readText: async () => 'from the file' },
      { out: line => lines.push(line), note: line => lines.push(`note: ${line}`) },
      env,
      clock,
    );
  return { sent, parked, lines, controller };
}

describe('SendMessageController', () => {
  it('should send the planned message with its label and read the message file after the typed words', async () => {
    const { sent, controller } = parts();
    await controller().execute('hadi', { message: 'hello', messageFile: 'm.txt', kind: 'fyi' });
    should(sent).deepEqual([{ message: 'hello\n\nfrom the file', attachmentIds: [], now: false, label: 'fyi' }]);
  });

  it('should park the caller after a delivered ask, and say so', async () => {
    const { parked, lines, controller } = parts();
    await controller({ callerFerret: 'me' }).execute('hadi', { message: 'ok?', ask: true });
    should(parked).deepEqual([{ caller: 'me', peer: 'f1', condition: 'a reply from hadi' }]);
    should(lines.some(line => line.includes('parked awaiting a reply from hadi'))).be.true();
  });

  it('should not fail a delivered message when the park itself fails', async () => {
    const { lines, controller } = parts({ parkFails: true });
    await controller({ callerFerret: 'me' }).execute('hadi', { message: 'ok?', ask: true });
    should(lines.some(line => line.includes('do not send it again'))).be.true();
  });

  it('should wait through a missing ledger row, then report the delivery', async () => {
    const { lines, controller } = parts({ statuses: [undefined, record('queued'), record('delivered')] });
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(lines.some(line => line.startsWith('note: delivered'))).be.true();
    should(WAIT_INTERVAL_MS).equal(2000);
  });

  it('should fail a wait on a message proven not delivered, and not on an unconfirmed one', async () => {
    const proven = parts({ statuses: [record('timed_out')] });
    await proven
      .controller()
      .execute('hadi', { message: 'hi', wait: true })
      .then(
        () => should.fail(undefined, undefined, 'expected a failure'),
        error => should(error).be.instanceOf(CommandError),
      );
    const unconfirmed = parts({ statuses: [record('unaccounted')] });
    await unconfirmed.controller().execute('hadi', { message: 'hi', wait: true });
    should(unconfirmed.lines.some(line => line.includes('unconfirmed'))).be.true();
  });

  it('should say a send with no id cannot be waited on', async () => {
    const { lines, controller } = parts({ result: result({ sendId: undefined }) });
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(lines.some(line => line.includes('this send has no id, so it cannot be waited on'))).be.true();
  });

  it('should stop waiting on a message still in the queue, say it is safe, and not fail', async () => {
    const { lines, controller } = parts();
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(
      lines.some(line => line.includes('still not typed into the agent after 5m') && line.includes('do not resend')),
    ).be.true();
  });

  it('should stop waiting on a message that never settles, and say where it stands', async () => {
    const { lines, controller } = parts({ after: record('queued') });
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(lines.some(line => line.startsWith('note: still queued') && line.includes('after 5m of waiting'))).be.true();
  });
});
