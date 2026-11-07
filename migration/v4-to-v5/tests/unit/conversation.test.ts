import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DraftSnapshotSchema, LinksFileSchema } from '@ferretry/plugin-conversation/contract';
import { chmod, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONVERSATION_PORT,
  conversationStep,
  DraftsDocumentSchema,
  V5_LINKS_FILE,
  V5_MESSAGE_TOKEN_KEY_FILE,
  v5DraftsFile,
  v5TurnsFolder,
} from '../../src/steps/conversation.ts';
import { STEPS } from '../../src/steps/index.ts';
import { foldV4Queue, latestV4Sends, V4SendLine } from '../../src/v4/conversation.ts';
import { AT, fixture } from './ferret-fixture.ts';

// A FAKE key: 32 fixed printable bytes, so a test can prove they are copied unchanged and never reach a report.
const FAKE_KEY = Buffer.from('FAKE-MESSAGE-TOKEN-KEY-0123456789'.slice(0, 32), 'utf8');
const FAKE_VALUE = 'FAKE-CONTENT-NEVER-IN-A-REPORT';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const raw = async (path: string, content: string | Buffer, mode = 0o600) => {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode });
  await chmod(target, mode);
};
const jsonl = (lines: readonly unknown[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;

const draft = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  sessionId,
  generation: 'g1',
  epoch: 0,
  rev: 3,
  text: 'FAKE draft text',
  items: [{ kind: 'attachment', id: 'att_1', name: 'a.png', mime: 'image/png', bytes: 10 }],
  updatedAt: AT,
  ...extra,
});

const queued = (id: string) => ({
  v: 1,
  id,
  sender: 'human',
  text: 'FAKE queued',
  attachmentIds: [],
  enqueuedAt: AT,
  state: 'queued',
  stateAt: AT,
  revision: 1,
});
const send = (sendId: string, fate: string) => ({
  sendId,
  acceptedAt: AT,
  acceptedTurn: 1,
  path: 'direct',
  message: 'FAKE send',
  matchText: 'FAKE match',
  fate,
  at: AT,
});

describe('conversation step', () => {
  test('is registered in place of the pending entry, after ferrets', () => {
    expect(STEPS.map(step => step.id).slice(0, 2)).toEqual(['ferrets', 'conversation']);
    expect(conversationStep.sealed).toEqual(['state/session-message-token.key']);
  });

  test('moves the message-token key byte for byte and never puts it in the report', async () => {
    await raw('state/session-message-token.key', FAKE_KEY);
    const time = new Date('2026-10-01T00:00:00.000Z');
    await utimes(join(f.from, 'state/session-message-token.key'), time, time);
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('pending');
    const moved = join(f.to, V5_MESSAGE_TOKEN_KEY_FILE);
    expect(V5_MESSAGE_TOKEN_KEY_FILE).toBe('state/conversation/message-token.key');
    expect(Buffer.compare(await readFile(moved), FAKE_KEY)).toBe(0);
    expect((await stat(moved)).mode & 0o777).toBe(0o600);
    expect((await stat(moved)).mtime.toISOString()).toBe(time.toISOString());
    expect(report.sealed).toEqual([{ file: V5_MESSAGE_TOKEN_KEY_FILE, bytes: 32 }]);
    const text = JSON.stringify(report);
    expect(text).not.toContain(FAKE_KEY.toString('utf8'));
    expect(text).not.toContain(FAKE_KEY.toString('base64'));
    expect(text).not.toContain(FAKE_KEY.toString('hex'));
  });

  test('refuses a key that is not 0600, naming the file and nothing in it', async () => {
    await raw('state/session-message-token.key', FAKE_KEY, 0o644);
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe('sealed key is not mode 0600: state/session-message-token.key');
    expect(await stat(join(f.to, V5_MESSAGE_TOKEN_KEY_FILE)).catch(() => undefined)).toBeUndefined();
  });

  test('copies turns byte for byte with modes and times, and omits links', async () => {
    await f.session('f1');
    await raw('state/sessions/f1/turns/turn-001.md', '# FAKE task\n');
    await raw('state/sessions/f1/turns/turn-001.by.json', '{"kind":"owner"}', 0o640);
    const time = new Date('2026-10-02T00:00:00.000Z');
    await utimes(join(f.from, 'state/sessions/f1/turns/turn-001.md'), time, time);
    await symlink('/nowhere/outside', join(f.from, 'state/sessions/f1/turns/linked.md'));
    const report = await conversationStep.run(f.ctx());

    const turns = join(f.to, v5TurnsFolder('f1'));
    expect(v5TurnsFolder('f1')).toBe('state/conversation/f1/turns');
    expect(await readFile(join(turns, 'turn-001.md'), 'utf8')).toBe('# FAKE task\n');
    expect(await readFile(join(turns, 'turn-001.by.json'), 'utf8')).toBe('{"kind":"owner"}');
    expect((await stat(join(turns, 'turn-001.by.json'))).mode & 0o777).toBe(0o640);
    expect((await stat(join(turns, 'turn-001.md'))).mtime.toISOString()).toBe(time.toISOString());
    expect(await stat(join(turns, 'linked.md')).catch(() => undefined)).toBeUndefined();
    expect(report.kept).toContainEqual({ what: 'turn files copied byte for byte', count: 2 });
    expect(report.note).toContain('1 link(s) in turns omitted');
  });

  test('writes the chat draft through the v5 snapshot schema; agenda reply drafts are read, not written', async () => {
    await f.session('f1');
    await f.put('state/shared-drafts/f1.json', draft('f1'));
    await f.put('state/shared-drafts/f1.items/A3.json', draft('f1', { slot: 'A3' }));
    await f.put('state/shared-drafts/gone.json', draft('gone'));
    const report = await conversationStep.run(f.ctx());

    const document = DraftsDocumentSchema.parse(JSON.parse(await readFile(join(f.to, v5DraftsFile('f1')), 'utf8')));
    expect(v5DraftsFile('f1')).toBe('state/conversation/f1/drafts');
    expect(document.items).toEqual({});
    expect(DraftSnapshotSchema.parse(document.chat)).toEqual(document.chat!);
    expect(document.chat).toMatchObject({ v: 1, ferret: 'f1', generation: 'g1', rev: 3, text: 'FAKE draft text' });
    expect(document.chat).not.toHaveProperty('sessionId');
    expect(document.chat).not.toHaveProperty('slot');
    expect((await stat(join(f.to, v5DraftsFile('f1')))).mode & 0o777).toBe(0o600);
    expect(report.kept).toContainEqual({ what: 'chat drafts', count: 1 });
    expect(report.note).toContain('agenda reply drafts 1');
    expect(report.note).toContain('1 orphan draft(s) omitted');
    expect(await stat(join(f.to, v5DraftsFile('gone'))).catch(() => undefined)).toBeUndefined();
  });

  test('a draft that names another session fails, naming the file only', async () => {
    await f.session('f1');
    await f.put('state/shared-drafts/f1.json', draft('other', { text: FAKE_VALUE }));
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe('shared draft names another session or slot: state/shared-drafts/f1.json');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('links every adopted conversation, under the harness plugin id', async () => {
    const transcript = (identity: string, id: string) => ({
      v: 1,
      home: '/fake/home',
      identity,
      harnessSessionId: id,
      file: `/fake/home/${id}.jsonl`,
    });
    await f.session('kept', {
      harness: 'claude',
      transcript: { ...transcript('adopted', '22222222-2222-4222-8222-222222222222'), resolvedAt: AT },
    });
    await f.session('made', { transcript: transcript('minted', '33333333-3333-4333-8333-333333333333') });
    const report = await conversationStep.run(f.ctx());

    const links = LinksFileSchema.parse(JSON.parse(await readFile(join(f.to, V5_LINKS_FILE), 'utf8')));
    expect(links.links).toEqual([
      { id: '22222222-2222-4222-8222-222222222222', harness: 'claude-code', ferret: 'kept', linkedAt: AT },
    ] as never);
    expect(report.kept).toContainEqual({ what: 'conversation links', count: 1 });
  });

  test('reads and checks the files whose v5 shape is the port’s, and writes none of them', async () => {
    await f.session('f1');
    await f.put('state/sessions/f1/state.json', { id: 'f1', status: 'awaiting_question' });
    await raw(
      'state/sessions/f1/channel/queue.jsonl',
      jsonl([
        { v: 1, kind: 'enqueued', at: AT, message: queued('q1') },
        { v: 1, kind: 'enqueued', at: AT, message: queued('q2') },
        { v: 1, kind: 'moved', at: AT, id: 'q1', state: 'typing' },
        { v: 1, kind: 'moved', at: AT, id: 'nobody', state: 'typing' },
      ]),
    );
    // Two lines for s1 (last wins), and a crash-truncated final line, which v4 skipped.
    await raw(
      'state/sessions/f1/channel/sends.jsonl',
      `${jsonl([send('s1', 'accepted'), send('s1', 'delivered'), send('s2', 'withdrawn')])}{"sendId":"s3",`,
    );
    await raw(
      'state/sessions/f1/channel/answers.jsonl',
      jsonl([
        { requestId: 'r1', toolUseId: 't1', fingerprint: 'fp', acceptedAt: AT, outcome: 'accepted', at: AT },
        { requestId: 'r1', toolUseId: 't1', fingerprint: 'fp', acceptedAt: AT, outcome: 'confirmed', at: AT },
      ]),
    );
    await raw('state/sessions/f1/channel/inbox.jsonl', jsonl([{ at: AT, type: 'message', message: 'FAKE in' }]));
    await raw(
      'state/sessions/f1/channel/outbox.jsonl',
      jsonl([{ at: AT, type: 'message', from: 'f1', to: 'owner', disposition: 'delivered', message: 'FAKE out' }]),
    );
    await f.put('state/sessions/f1/question-asked.json', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_1',
      transcript_path: '/fake/t.jsonl',
      tool_input: { questions: [{ question: 'FAKE?', options: [{ label: 'Yes' }] }] },
    });
    await f.put('state/attachments/daemon1/f1/att_1/manifest.json', {
      id: 'att_1',
      filename: 'a.png',
      mime: 'image/png',
      size: 4,
      sha256: 'b'.repeat(64),
      createdAt: AT,
    });
    await raw('state/attachments/daemon1/f1/att_1/original', Buffer.from([0, 1, 2, 3]));
    await f.put('state/renders/ab/abcdef.json', {
      v: 1,
      id: 'abcdef',
      kind: 'svg',
      alt: 'FAKE',
      bytes: 5,
      sha256: 'c'.repeat(64),
      createdAt: AT,
      author: { sessionId: 'f1' },
    });
    await raw('state/renders/ab/abcdef.payload', '<svg/>');
    const report = await conversationStep.run(f.ctx());

    expect(report.status).toBe('pending');
    expect(report.note).toContain(CONVERSATION_PORT);
    expect(report.note).toContain(
      'queue messages 2, sends 2, answer receipts 1, inbox lines 1, outbox lines 1, open questions 1, attachments 1, renders 1',
    );
    for (const absent of [
      'state/conversation/f1/queue.jsonl',
      'state/conversation/f1/sends.jsonl',
      'state/conversation/f1/answers.jsonl',
      'state/conversation/f1/question.json',
      'state/conversation/f1/attachments',
      'state/conversation/renders',
    ])
      expect(await stat(join(f.to, absent)).catch(() => undefined)).toBeUndefined();
  });

  test('an ended ferret’s question is not counted as open', async () => {
    await f.session('f1');
    await f.put('state/sessions/f1/state.json', { id: 'f1', status: 'completed' });
    await f.put('state/sessions/f1/question-asked.json', { not: 'checked for an ended ferret' });
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('pending');
    expect(report.note).toContain('open questions 0');
  });

  test('a bad line in the middle of a log fails, naming the file and line, never the value', async () => {
    await f.session('f1');
    await raw('state/sessions/f1/channel/sends.jsonl', jsonl([{ sendId: FAKE_VALUE }, send('s1', 'accepted')]));
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe('v4 log line 1 does not match its v4 schema: state/sessions/f1/channel/sends.jsonl');
    expect(JSON.stringify(report)).not.toContain(FAKE_VALUE);
  });

  test('an attachment without its original fails', async () => {
    await f.put('state/attachments/daemon1/f1/att_1/manifest.json', {
      id: 'att_1',
      filename: 'a.png',
      mime: 'image/png',
      size: 4,
      sha256: 'b'.repeat(64),
      createdAt: AT,
    });
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe('attachment has no original file: state/attachments/<daemonId>/f1/att_1');
  });

  test('a dry run reports the key size and writes nothing', async () => {
    await raw('state/session-message-token.key', FAKE_KEY);
    await f.session('f1');
    await raw('state/sessions/f1/turns/turn-001.md', '# FAKE\n');
    await f.put('state/shared-drafts/f1.json', draft('f1'));
    const report = await conversationStep.run(f.ctx(true));
    expect(report.sealed).toEqual([{ file: V5_MESSAGE_TOKEN_KEY_FILE, bytes: 32 }]);
    expect(report.note).toContain('dry run: nothing written');
    expect(await stat(join(f.to, 'state')).catch(() => undefined)).toBeUndefined();
  });

  test('an empty home is pending with nothing kept', async () => {
    const report = await conversationStep.run(f.ctx());
    expect(report.status).toBe('pending');
    expect(report.sealed).toEqual([]);
    expect(report.kept.every(item => item.count === 0)).toBe(true);
  });
});

describe('v4 conversation readers', () => {
  test('the queue fold applies only legal moves, like v4', () => {
    const messages = foldV4Queue([
      { v: 1, kind: 'enqueued', at: AT, message: queued('q1') as never },
      { v: 1, kind: 'enqueued', at: AT, message: queued('q1') as never },
      { v: 1, kind: 'edited', at: AT, id: 'q1', text: 'edited', revision: 2 },
      { v: 1, kind: 'moved', at: AT, id: 'q1', state: 'read' },
      { v: 1, kind: 'moved', at: AT, id: 'q1', state: 'typing', batch: 'q1' },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'edited', revision: 2, state: 'typing', deliveredAs: 'q1', version: 5 });
  });

  test('the send ledger keeps the last line per send, in first-seen order', () => {
    const lines = [send('a', 'accepted'), send('b', 'accepted'), send('a', 'delivered')].map(line =>
      V4SendLine.parse(line),
    );
    expect(latestV4Sends(lines).map(line => [line.sendId, line.fate])).toEqual([
      ['a', 'delivered'],
      ['b', 'accepted'],
    ]);
  });
});
