import { describe, it } from 'bun:test';
import should from 'should';
import { CommandError } from '../../../cli/lib/errors.ts';
import { SendMessageController, WAIT_ROUND_MS } from '../../../cli/lib/send/controller.ts';
import type { SendGateway } from '../../../cli/lib/send/ports.ts';
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
  const asked: (number | undefined)[] = [];
  const gateway: SendGateway = {
    send: async (_ferret, request) => {
      sent.push(request);
      return options.result ?? result();
    },
    sendStatus: async (_ferret, _sendId, waitMs) => {
      asked.push(waitMs);
      return statuses.length > 0 ? statuses.shift() : options.after;
    },
    upload: async () => ({ id: 'a1' }),
    parkUntilReply: async (caller, details) => {
      if (options.parkFails) throw new Error('daemon said no');
      parked.push({ caller, ...details });
    },
  };
  const controller = (env: { callerFerret?: string } = {}) =>
    new SendMessageController(
      gateway,
      { readText: async () => 'from the file' },
      { out: line => lines.push(line), note: line => lines.push(`note: ${line}`) },
      env,
    );
  return { sent, parked, lines, controller, asked, gateway };
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

  it('should wait through a queued message, then report the delivery, each round asking the daemon to hold the read', async () => {
    const { lines, controller, asked } = parts({ statuses: [record('queued'), record('queued'), record('delivered')] });
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(lines.some(line => line.startsWith('note: delivered'))).be.true();
    should(asked).deepEqual([WAIT_ROUND_MS, WAIT_ROUND_MS, WAIT_ROUND_MS]);
    should(WAIT_ROUND_MS).equal(30_000);
  });

  it('should not fail a sent message when the daemon has too many waiters: it says so and not to send it again', async () => {
    const { lines, controller, gateway } = parts();
    gateway.sendStatus = async () => {
      throw Object.assign(new Error('too many sends are being waited on right now'), {
        status: 429,
        code: 'too_many_waiters',
      });
    };
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(
      lines.some(line => line.includes('too many sends are being waited on') && line.includes('do not send it again')),
    ).be.true();
    should(lines.some(line => line.includes('fy queue hadi'))).be.true();
    should(lines[lines.length - 1]).equal('hadi: delivered');
  });

  it('should still fail the command on any other error while waiting', async () => {
    const { controller, gateway } = parts();
    gateway.sendStatus = async () => {
      throw Object.assign(new Error('boom'), { status: 500, code: 'internal' });
    };
    let thrown: unknown;
    await controller()
      .execute('hadi', { message: 'hi', wait: true })
      .catch((error: unknown) => (thrown = error));
    should(thrown).be.an.Error();
  });

  it('should ask for at most ten rounds of waiting, however long the send takes to settle', async () => {
    const { controller, asked } = parts({ after: record('queued') });
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(asked).have.length(10);
  });

  it('should not ask for a wait unless --wait was given', async () => {
    const { controller, asked } = parts();
    await controller().execute('hadi', { message: 'hi' });
    should(asked).deepEqual([]);
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

  it('should stop at once on a send the daemon has no record of, say so, and not fail or loop', async () => {
    const { lines, controller, asked } = parts();
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(asked).have.length(1);
    should(
      lines.some(line => line.includes('no record of this send') && line.includes('before sending it again')),
    ).be.true();
    should(lines.some(line => line.includes('5m'))).be.false();
  });

  it('should stop waiting on a message that never settles, and count its checks rather than claim minutes', async () => {
    const { lines, controller } = parts({ after: record('queued') });
    await controller().execute('hadi', { message: 'hi', wait: true });
    should(
      lines.some(line => line.startsWith('note: still queued') && line.includes('after 10 checks of up to 30s each')),
    ).be.true();
    should(lines.some(line => line.includes('5m'))).be.false();
  });
});
