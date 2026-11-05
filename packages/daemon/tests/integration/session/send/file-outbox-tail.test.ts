import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileOutboxTail } from '../../../../src/adapters/index.ts';

/** `FileOutboxTail` against a real outbox on disk: the open, stat, chunked reads and close are all node:fs. */

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function sessionsRoot(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'fy-outbox-tail-'));
  homes.push(home);
  return home;
}

function tailOver(root: string): FileOutboxTail {
  return new FileOutboxTail(id => join(root, id));
}

async function writeOutbox(root: string, sessionId: string, content: string): Promise<string> {
  const channel = join(root, sessionId, 'channel');
  await mkdir(channel, { recursive: true });
  const path = join(channel, 'outbox.jsonl');
  await writeFile(path, content);
  return path;
}

const line = (entry: Record<string, unknown>): string => `${JSON.stringify(entry)}\n`;
const message = (to: string, text: string, at: string): string => line({ type: 'message', to, at, message: text });

describe('FileOutboxTail', () => {
  it('finds nothing for a session id that is not a safe path segment', async () => {
    const root = await sessionsRoot();
    should(await tailOver(root).newestMessageTo('../escape', 'lead')).be.undefined();
  });

  it('finds nothing when the session has no outbox yet', async () => {
    const root = await sessionsRoot();
    should(await tailOver(root).newestMessageTo('session-1', 'lead')).be.undefined();
  });

  it('finds nothing in an empty outbox', async () => {
    const root = await sessionsRoot();
    await writeOutbox(root, 'session-1', '');
    should(await tailOver(root).newestMessageTo('session-1', 'lead')).be.undefined();
  });

  it('returns the newest message to the recipient among several', async () => {
    const root = await sessionsRoot();
    await writeOutbox(
      root,
      'session-1',
      message('lead', 'first to lead', '2026-08-01T10:00:00.000Z') +
        message('other', 'to someone else', '2026-08-01T11:00:00.000Z') +
        message('lead', 'second to lead', '2026-08-01T12:00:00.000Z') +
        message('other', 'newest, but to someone else', '2026-08-01T13:00:00.000Z'),
    );
    should(await tailOver(root).newestMessageTo('session-1', 'lead')).eql({
      at: '2026-08-01T12:00:00.000Z',
      text: 'second to lead',
    });
  });

  it('finds nothing when every message went to someone else', async () => {
    const root = await sessionsRoot();
    await writeOutbox(root, 'session-1', message('other', 'not for the lead', '2026-08-01T10:00:00.000Z'));
    should(await tailOver(root).newestMessageTo('session-1', 'lead')).be.undefined();
  });

  it('reads a record longer than one chunk whole and still returns the newest message', async () => {
    const root = await sessionsRoot();
    const report = 'x'.repeat(70 * 1024);
    await writeOutbox(
      root,
      'session-1',
      message('lead', 'older', '2026-08-01T10:00:00.000Z') + message('lead', report, '2026-08-01T11:00:00.000Z'),
    );
    should(await tailOver(root).newestMessageTo('session-1', 'lead')).eql({
      at: '2026-08-01T11:00:00.000Z',
      text: report,
    });
  });

  it('reaches back across chunks to an older message to the recipient', async () => {
    const root = await sessionsRoot();
    const filler = 'y'.repeat(70 * 1024);
    await writeOutbox(
      root,
      'session-1',
      message('lead', 'only one to lead', '2026-08-01T10:00:00.000Z') +
        message('other', filler, '2026-08-01T11:00:00.000Z'),
    );
    should(await tailOver(root).newestMessageTo('session-1', 'lead')).eql({
      at: '2026-08-01T10:00:00.000Z',
      text: 'only one to lead',
    });
  });

  it('rethrows an open failure that is not a missing file', async () => {
    const root = await sessionsRoot();
    // A regular file where the channel directory belongs: opening below it fails with ENOTDIR.
    await mkdir(join(root, 'session-1'), { recursive: true });
    await writeFile(join(root, 'session-1', 'channel'), 'not a directory');
    await tailOver(root)
      .newestMessageTo('session-1', 'lead')
      .then(
        () => should.fail(undefined, undefined, 'expected the open to fail'),
        (error: NodeJS.ErrnoException) => should(error.code).equal('ENOTDIR'),
      );
  });

  it('closes the file and rethrows when reading it fails', async () => {
    const root = await sessionsRoot();
    // The outbox path is a directory: it opens for reading, then the first read fails with EISDIR.
    await mkdir(join(root, 'session-1', 'channel', 'outbox.jsonl'), { recursive: true });
    await tailOver(root)
      .newestMessageTo('session-1', 'lead')
      .then(
        () => should.fail(undefined, undefined, 'expected the read to fail'),
        (error: NodeJS.ErrnoException) => should(error.code).equal('EISDIR'),
      );
  });

  it('scan reads no more of the outbox than its byte budget and reports what it read', async () => {
    const root = await sessionsRoot();
    const content =
      message('lead', 'buried', '2026-08-01T10:00:00.000Z') +
      message('other', 'x'.repeat(2_000), '2026-08-01T11:00:00.000Z');
    await writeOutbox(root, 'session-1', content);

    const capped = await tailOver(root).scan('session-1', 'lead', 500);
    const full = await tailOver(root).scan('session-1', 'lead');

    should(capped.message).be.undefined();
    should(capped.scanned).equal(500);
    should(full.message?.text).equal('buried');
    should(full.scanned).equal(Buffer.byteLength(content));
  });

  it('scan reports nothing read for a missing outbox', async () => {
    const root = await sessionsRoot();
    should(await tailOver(root).scan('session-1', 'lead', 500)).deepEqual({ message: undefined, scanned: 0 });
  });
});
