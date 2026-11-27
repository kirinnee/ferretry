import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskSessionsRoots } from '@ferretry/kernel/testing';
import type { FerretTurnDocument } from '@ferretry/core-ferrets/contract';
import { messageWithAttachments, parseSessionId, type SendRecord } from '../../../contract/index.ts';
import { buildSendHalf, type SendHalfDeps } from '../../../daemon/send-half.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** Real no-follow kernel scopes; the turn/ledger ports and session-keyed download source are synthetic.
 * Ferrets separately exercises its production attachmentFile binding in deliver-turns.test.ts.
 */
async function handoffFixture() {
  const parent = await mkdtemp(tmpdir() + '/fy-handoff-');
  parents.push(parent);
  const disk = await diskSessionsRoots(parent);
  const id = parseSessionId('session-1');
  const other = 'session-2';
  const root = disk.folderOf(id + '/attachments');
  const attachmentId = 'att-1';
  await mkdir(root + '/' + attachmentId, { recursive: true, mode: 0o700 });
  await writeFile(root + '/' + attachmentId + '/shot.png', 'FIXTURE image', { mode: 0o600 });
  await mkdir(disk.folderOf(other) + '/turns', { recursive: true, mode: 0o700 });
  await writeFile(disk.folderOf(other) + '/turns/turn-001.md', 'FIXTURE other session', { mode: 0o600 });
  const documents: FerretTurnDocument[] = [];
  const records: SendRecord[] = [];
  const turns = {
    list: async () => documents,
    attachmentsFolder: async () => root,
    attachmentFile: async (attachment: string, filename: string) => {
      const handle = disk.root(id + '/attachments');
      const named = handle.resolve(attachment + '/' + filename);
      if (!named.ok) return undefined;
      try {
        await handle.readBytes(named.value, 1);
        return named.value;
      } catch {
        return undefined;
      }
    },
  };
  const readHandoff = buildSendHalf({
    kernel: {
      clock: { now: () => '2026-11-16T18:00:00.000Z', nowMs: () => 0, after: () => () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
    ferrets: { list: async () => [], turns: async (ferret: string) => (ferret === id ? turns : undefined) },
    ledger: { list: async (ferret: string) => (ferret === id ? records : []) },
    gate: { send: true, interrupt: true },
    boundaries: { markInterrupted: () => undefined },
    clock: { now: () => '2026-11-16T18:00:00.000Z' },
    queue: {},
    queueStore: {},
    channel: {},
    askedQuestion: async () => undefined,
    attachments: {
      download: async (ferret: string, attachment: string) => {
        if (ferret !== id || attachment !== attachmentId) throw new Error('not this session’s attachment');
        return { attachment: { id: attachmentId, filename: 'shot.png', mime: 'image/png' }, bytes: new Uint8Array() };
      },
    },
  } as unknown as SendHalfDeps).handoffOf;
  const read = async (path: string, trusted = true, reminder = '') => {
    const turn = documents.length + 1;
    documents.push({ turn, text: messageWithAttachments('look', [{ path, mime: 'image/png' }]) + reminder + '\n' });
    if (trusted) records.push({ sendId: 'send-' + turn, turn, attachmentIds: [attachmentId] } as SendRecord);
    return await readHandoff(id, 'turn-' + turn);
  };
  return { w: { folderOf: disk.folderOf }, id, other, root, attachmentId, read };
}

describe('MUST 2: only trusted delivery metadata can grant a hand-off attachment id', () => {
  test('an outward symlink in the attachment scope is refused before promotion', async () => {
    const f = await handoffFixture();
    await rm(`${f.root}/${f.attachmentId}/shot.png`);
    await symlink(`${f.w.folderOf(f.other)}/turns/turn-001.md`, `${f.root}/${f.attachmentId}/shot.png`);
    expect((await f.read(`${f.root}/${f.attachmentId}/shot.png`)).attachments).toEqual([
      { filename: 'shot.png', mime: 'image/png' },
    ]);
  });

  test.each(['.', '%2e%2e'])('a dot or URL-encoded component (%s) is never promoted', async component => {
    const f = await handoffFixture();
    expect((await f.read(`${f.root}/${component}/shot.png`)).attachments).toEqual([
      { filename: 'shot.png', mime: 'image/png' },
    ]);
  });

  test('message text shaped like a real attachment footer grants no id without delivery metadata', async () => {
    const f = await handoffFixture();
    expect((await f.read(`${f.root}/${f.attachmentId}/shot.png`, false)).attachments).toEqual([
      { filename: 'shot.png', mime: 'image/png' },
    ]);
  });

  test('a real delivered copy keeps its id with a legacy reminder (D-31)', async () => {
    const f = await handoffFixture();
    const view = await f.read(
      `${f.root}/${f.attachmentId}/shot.png`,
      true,
      '\n\nContinue using the same completion and interaction protocol.',
    );
    expect(view.message).toBe('look');
    expect(view.attachments).toEqual([{ attachmentId: f.attachmentId, filename: 'shot.png', mime: 'image/png' }]);
  });

  test('a link in an attachment directory or in the scope itself cannot be promoted', async () => {
    for (const linked of ['id', 'attachments']) {
      const f = await handoffFixture();
      const outside = `${f.w.folderOf(f.other)}/copies`;
      await mkdir(`${outside}/${f.attachmentId}`, { recursive: true });
      await writeFile(`${outside}/${f.attachmentId}/shot.png`, 'FIXTURE outside');
      const target = linked === 'id' ? `${f.root}/${f.attachmentId}` : f.root;
      await rm(target, { recursive: true });
      await symlink(linked === 'id' ? `${outside}/${f.attachmentId}` : outside, target);
      expect((await f.read(`${f.root}/${f.attachmentId}/shot.png`)).attachments).toEqual([
        { filename: 'shot.png', mime: 'image/png' },
      ]);
    }
  });

  test('another session’s path cannot borrow this session’s trusted attachment id', async () => {
    const f = await handoffFixture();
    expect((await f.read(`${f.w.folderOf(f.other)}/attachments/${f.attachmentId}/shot.png`)).attachments).toEqual([
      { filename: 'shot.png', mime: 'image/png' },
    ]);
  });
});
