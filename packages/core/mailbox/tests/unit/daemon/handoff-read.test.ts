import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretTurnDocument } from '@ferretry/core-ferrets/contract';
import { messageWithAttachments, parseSessionId } from '../../../contract/index.ts';
import { buildSendHalf, type SendHalfDeps } from '../../../daemon/send-half.ts';

const ID = parseSessionId('session-1');
const ROOT = '/fy/state/ferrets/sessions/session-1/attachments';
/** The note old revive documents still end with (the send half names it too). */
const REMINDER = 'Continue using the same completion and interaction protocol.';

/** The REAL send half over a Ferrets that lends one ferret's turn documents, its channel files and its attachments folder. */
function world(parts: {
  readonly turns?: readonly FerretTurnDocument[];
  readonly queued?: Readonly<Record<string, string>>;
  readonly root?: string | undefined;
  readonly delivered?: readonly string[];
}) {
  const turns = {
    list: async () => parts.turns ?? [],
    readQueued: async (sendId: string) => parts.queued?.[sendId],
    ...(parts.root === undefined ? {} : { attachmentsFolder: async () => parts.root as string }),
    ...(parts.root === undefined
      ? {}
      : { attachmentFile: async (id: string, filename: string) => `${parts.root}/${id}/${filename}` }),
  };
  const send = buildSendHalf({
    kernel: {
      clock: { now: () => '2026-11-16T18:00:00.000Z', nowMs: () => 0, after: () => () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      redaction: { read: (text: string) => text },
    },
    ferrets: { get: async () => undefined, list: async () => [], turns: async () => turns },
    gate: { send: true, interrupt: true },
    boundaries: { markInterrupted: () => undefined },
    clock: { now: () => '2026-11-16T18:00:00.000Z' },
    queue: {},
    queueStore: {},
    ledger: {
      list: async () => (parts.turns ?? []).map(turn => ({ turn: turn.turn, attachmentIds: parts.delivered ?? [] })),
    },
    attachments: {
      lookup: async (_ferret: string, id: string) => ({ id, filename: 'shot.png', mime: 'image/png' }),
      download: async (_ferret: string, id: string) => ({
        attachment: { id, filename: 'shot.png', mime: 'image/png' },
        bytes: new Uint8Array(),
      }),
    },
    channel: {},
    askedQuestion: async () => undefined,
  } as unknown as SendHalfDeps);
  return send.handoffOf;
}

describe('a hand-off read back by the Mailbox', () => {
  it('D-22: should read a queued message by its queued-<send id> pointer, and 404 one that was never filed', async () => {
    const handoffOf = world({ queued: { 'send-1': 'the long words\nover two lines' }, root: ROOT });

    should(await handoffOf(ID, 'queued-send-1')).deepEqual({
      name: 'queued-send-1',
      message: 'the long words\nover two lines',
      attachments: [],
    });
    await handoffOf(ID, 'queued-send-2').should.be.rejectedWith(/not there/u);
  });

  it('D-30: should give an attachment id only to a file under the ferret’s own attachments folder', async () => {
    const text = `${messageWithAttachments('look', [
      { path: '/elsewhere/attachments/att_9/planted.png', mime: 'image/png' },
      { path: `${ROOT}/att_1/shot.png`, mime: 'image/png' },
    ])}\n`;
    const handoffOf = world({ turns: [{ turn: 8, text }], root: ROOT, delivered: ['att_1'] });

    should((await handoffOf(ID, 'turn-008')).attachments).deepEqual([
      // A path the document names outside the trusted root is only a label, whatever its folders are called.
      { filename: 'planted.png', mime: 'image/png' },
      { attachmentId: 'att_1', filename: 'shot.png', mime: 'image/png' },
    ]);
  });

  it('D-30: should give no attachment id at all when Ferrets names no attachments folder', async () => {
    const text = `${messageWithAttachments('look', [{ path: `${ROOT}/att_1/shot.png`, mime: 'image/png' }])}\n`;

    should((await world({ turns: [{ turn: 8, text }] })(ID, 'turn-008')).attachments).deepEqual([
      { filename: 'shot.png', mime: 'image/png' },
    ]);
  });

  it('D-31: should keep the image chip’s id when the old protocol reminder trails the attachment list', async () => {
    const text = `${messageWithAttachments('look', [{ path: `${ROOT}/att_1/shot.png`, mime: 'image/png' }])}\n\n${REMINDER}\n`;
    const handoffOf = world({ turns: [{ turn: 8, text }], root: ROOT, delivered: ['att_1'] });

    should(await handoffOf(ID, 'turn-008')).deepEqual({
      name: 'turn-008',
      message: 'look',
      attachments: [{ attachmentId: 'att_1', filename: 'shot.png', mime: 'image/png' }],
    });
  });
});
