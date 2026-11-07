/**
 * Parity rows F-* that Conversation owns (docs/design/rebuild-parity.tsv): where today's file now lives. Each tested row
 * drives the adapter that reads or writes it and checks which declared state file, under which name, it touched. A row
 * whose 5.0 writer waits on a seam is `test.skip` naming the seam; a row the parity owner rule placed here but that
 * another plugin holds says so.
 */
import { describe, expect, test } from 'bun:test';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import {
  ANSWERS_STATE,
  ATTACHMENT_MANIFEST_STATE,
  CONVERSATION_STATE,
  DRAFTS_STATE,
  INBOX_STATE,
  MESSAGE_TOKEN_KEY_STATE,
  OUTBOX_STATE,
  QUESTION_STATE,
  QUEUE_STATE,
  RENDER_META_STATE,
  SENDS_STATE,
} from '../../../contract/index.ts';
import { StateAttachmentOriginals } from '../../../daemon/attachments/adapters/originals.ts';
import { StateSendChannel, StateSendLedger } from '../../../daemon/delivery/adapters/index.ts';
import { StateDraftRepository } from '../../../daemon/drafts/adapters/index.ts';
import { StateAnswerLedger } from '../../../daemon/questions/adapters/state-answer-ledger.ts';
import { readAskedQuestion } from '../../../daemon/questions/adapters/state-asked-question.ts';
import { StateQueueStore } from '../../../daemon/queue/adapters/index.ts';
import { messageTokenCodec } from '../../../daemon/reader/adapters/message-token-key.ts';
import { StateRenderRepository } from '../../../daemon/renders/adapters/render-store.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import { memoryStatePort } from '../../support/state.ts';

const F1 = parseSessionId('f1');
const AT = '2026-11-07T09:00:00.000Z';
const clock = { now: () => AT as never };

/** Where each state call carries the name of the file in a collection: after the file, or after the value written. */
const NAME_AT: Readonly<Record<string, number>> = {
  read: 0,
  lines: 0,
  remove: 0,
  write: 1,
  append: 1,
  update: 1,
  list: -1,
};

/** The memory state port, recording `<file path> <name>` for every call an adapter makes. */
function recorded() {
  const inner = memoryStatePort(CONVERSATION_STATE);
  const touched: string[] = [];
  const state = new Proxy(inner, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      const at = NAME_AT[String(key)];
      if (typeof value !== 'function' || at === undefined) return value;
      return (file: StateFileDef, ...rest: unknown[]) => {
        const name = at < 0 ? undefined : rest[at];
        touched.push(typeof name === 'string' ? `${file.path} ${name}` : file.path);
        return (value as (...args: unknown[]) => unknown).call(target, file, ...rest);
      };
    },
  }) as StatePort;
  return { state, touched };
}

describe('the files a ferret’s conversation is kept in', () => {
  test('F-0316 F-0399 the queue is the ferret’s queue.jsonl', async () => {
    const { state, touched } = recorded();
    expect(QUEUE_STATE.path).toBe('*/queue.jsonl');
    expect(await new StateQueueStore(state).read(F1)).toEqual([]);
    expect(touched).toEqual(['*/queue.jsonl f1']);
  });

  test('F-0319 F-0407 the send ledger is the ferret’s sends.jsonl', async () => {
    const { state, touched } = recorded();
    expect(SENDS_STATE.path).toBe('*/sends.jsonl');
    expect(await new StateSendLedger(state, clock).list(F1)).toEqual([]);
    expect(touched).toEqual(['*/sends.jsonl f1']);
  });

  test('F-0312 F-0368 F-0314 F-0390 what reached a ferret is its inbox.jsonl, what it sent its outbox.jsonl', async () => {
    const { state, touched } = recorded();
    const channel = new StateSendChannel(state);
    await channel.recordInbound(F1, { at: AT, message: 'hello' });
    await channel.recordOutbound(F1, {
      at: AT,
      from: 'f1',
      to: 'lead',
      disposition: 'delivered' as never,
      message: 'done',
    });
    expect([INBOX_STATE.path, OUTBOX_STATE.path]).toEqual(['*/inbox.jsonl', '*/outbox.jsonl']);
    expect(touched).toEqual(['*/inbox.jsonl f1', '*/outbox.jsonl f1']);
  });

  test('F-0071 F-0311 the answer ledger is the ferret’s answers.jsonl', async () => {
    const { state, touched } = recorded();
    expect(ANSWERS_STATE.path).toBe('*/answers.jsonl');
    expect((await new StateAnswerLedger(state, clock).all(F1)).size).toBe(0);
    expect(touched).toEqual(['*/answers.jsonl f1']);
  });

  test('F-0331 the question a ferret asked is its question.json', async () => {
    const { state, touched } = recorded();
    expect(QUESTION_STATE.path).toBe('*/question.json');
    expect(await readAskedQuestion(state, 'f1', '/home/user/transcript.jsonl', 0)).toBeUndefined();
    expect(touched).toEqual(['*/question.json f1']);
  });

  test('F-0052 F-0346 F-0347 the chat draft and every item’s draft are the ferret’s drafts document', async () => {
    const { state, touched } = recorded();
    expect(DRAFTS_STATE.path).toBe('*/drafts');
    const drafts = new StateDraftRepository(state, new KeyedSerialExecutor());
    expect(await drafts.load('f1')).toBeUndefined();
    expect(await drafts.items('f1')).toEqual([]);
    expect(new Set(touched)).toEqual(new Set(['*/drafts f1']));
  });

  test('F-0059 F-0310 F-0378 an attachment’s manifest is one file per ferret and attachment', async () => {
    const { state, touched } = recorded();
    expect(ATTACHMENT_MANIFEST_STATE.path).toBe('attachments/*.manifest');
    const originals = new StateAttachmentOriginals(state);
    expect(await originals.attachmentIds('f1')).toEqual([]);
    expect(await originals.readManifest('f1', 'att_1')).toBeUndefined();
    expect(touched).toEqual(['attachments/*.manifest', 'attachments/*.manifest f1~att_1']);
  });

  test('F-0289 renders are kept in the renders folder, one meta per render', async () => {
    const { state, touched } = recorded();
    expect(RENDER_META_STATE.path).toBe('renders/*.json');
    expect(await new StateRenderRepository(state).listMetas()).toEqual([]);
    expect(touched).toEqual(['renders/*.json']);
  });

  test('F-0297 F-0298 F-0408 the message-token key is one owner-only secret file, minted once', async () => {
    const { state, touched } = recorded();
    expect([MESSAGE_TOKEN_KEY_STATE.path, MESSAGE_TOKEN_KEY_STATE.store, MESSAGE_TOKEN_KEY_STATE.mode]).toEqual([
      'message-token.key',
      'secret',
      0o600,
    ]);
    await messageTokenCodec(state).tag(new Uint8Array([1]));
    expect(touched).toEqual(['message-token.key', 'message-token.key']);
  });
});

describe('rows whose 5.0 writer waits on a seam', () => {
  test.skip('F-0215 the work search epoch from the vault documents — pending port: kernel Redaction.generation', () => {});
  test.skip('F-0306 F-0307 F-0317 F-0318 a send’s turn file and its .by.json — pending port: Ferrets deliver seam', () => {});
  test.skip('F-0340 F-0343 the turns folder and turn-NNN.md — pending port: Ferrets deliver seam', () => {});
  test.skip('F-0344 F-0345 turn-001.md written at start and handover — pending port: Ferrets deliver seam', () => {});
  test.skip('F-0313 F-0389 the outbox tail — pending port: Ferrets deliver seam', () => {});
  test.skip('F-0315 F-0391 fy signal writing the outbox — pending port: Ferrets deliver seam', () => {});
  test.skip('F-0341 F-0342 Board reading the owner’s words from turn files — pending port: transcript seam', () => {});
  test.skip('F-0015 F-0016 F-0050 F-0367 Lessons mining turns and the inbox — pending port: transcript seam', () => {});
  test.skip('F-0014 F-0380 a move copying the attachment manifests — pending port: Ferrets move seam', () => {});
});

describe('rows the parity owner rule placed here that another plugin holds', () => {
  test.skip('F-0021 F-0022 Claude subagent transcripts — not Conversation’s: claude-code (Usage reads them)', () => {});
  test.skip('F-0031 F-0032 the Codex rollout index — not Conversation’s: codex', () => {});
  test.skip('F-0290 F-0291 F-0398 the restart queue — not Conversation’s: ferrets', () => {});
});
