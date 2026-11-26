import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openTranscriptBytes, type FerretId, type FencedPath } from '@ferretry/core-ferrets/contract';
import { diskRoot } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import type { Question } from '../../../contract/index.ts';
import { FileTranscriptReads } from '../../../daemon/reader/adapters/file-reads.ts';
import { CodexTranscriptParser } from '../../../daemon/reader/lib/transcript/codex.ts';
import { tailTranscriptEvents } from '../../../daemon/reader/lib/session/reader.ts';
import { QUESTION_TAIL_EVENTS, QuestionWatch, type QuestionWatchDeps } from '../../../daemon/questions/lib/watch.ts';
import { appendFile, mkdtemp, newSource, rename, rm, truncate, writeFile } from '../../support/disk-files.ts';

/**
 * A stored Codex question is retired only on POSITIVE evidence (review MUST 1, D-02): its exact result, or the ferret's
 * transcript being a different conversation file. A tail that merely lacks the call is NOT that: the real reader reads
 * the last 16 MiB of a rollout, so a long one hands back a short tail without the call that is still open. These cases
 * run the real Codex parser and the real tail reader over real files.
 */

const MiB = 1024 * 1024;
const ASKED = '2026-11-14T01:00:00.000Z' as Instant;
const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
const call = (id: string): string =>
  line({
    timestamp: ASKED,
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: id,
      name: 'request_user_input',
      arguments: JSON.stringify({
        questions: [{ header: 'Mode', question: 'Which mode?', options: [{ label: 'Fast' }, { label: 'Slow' }] }],
      }),
    },
  });
const result = (id: string): string =>
  line({
    timestamp: ASKED,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: 'Fast' },
  });
const compacted = (): string =>
  line({ timestamp: ASKED, type: 'compacted', payload: { message: 'earlier work, summarised' } });
const chatter = (count: number): string =>
  Array.from({ length: count }, (_, i) =>
    line({
      timestamp: ASKED,
      type: 'response_item',
      payload: {
        type: 'message',
        id: `m${String(i)}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: `note ${String(i)}` }],
      },
    }),
  ).join('');

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

async function world() {
  const folder = await mkdtemp('question-real-tail-');
  folders.push(folder);
  const files = { rollout: join(folder, 'rollout-a.jsonl'), other: join(folder, 'rollout-b.jsonl') };
  const state = { file: files.rollout, conversation: 'conv-a', current: undefined as Question | undefined };
  const source = newSource(new CodexTranscriptParser());
  const cleared: string[] = [];
  const deps: QuestionWatchDeps = {
    roster: async () => [{ id: 'cody', harness: 'codex', state: 'working' }],
    harness: async () => undefined,
    current: async () => state.current,
    lastAnswered: async () => undefined,
    write: async () => undefined,
    clear: async (_ferret, id) => {
      cleared.push(id);
      state.current = undefined;
    },
    asked: async () => undefined,
    answered: async () => undefined,
    // The seam the daemon wires: the real reader's tail over the ferret's rollout file.
    transcriptEvents: async (_ferret, limit) =>
      await tailTranscriptEvents(source, state.file, 'cody', limit ?? QUESTION_TAIL_EVENTS),
    conversation: async () => state.conversation,
    writeProjected: async (_ferret, pending, _askedAt, conversation) =>
      (state.current = {
        format: 1,
        toolUseId: pending.toolUseId,
        text: 'Which mode?',
        options: [{ label: 'Fast' }, { label: 'Slow' }],
        multiple: false,
        askedAt: ASKED,
        ...(conversation === undefined ? {} : { conversation }),
      }),
  };
  return { files, state, cleared, watch: new QuestionWatch(deps) };
}

/** More than the reader's 16 MiB window of sparse bytes, then a compaction record: the tail finds far fewer than 200 events. */
async function growPastTheWindow(file: string): Promise<void> {
  await truncate(file, 17 * MiB);
  await appendFile(file, `\n${compacted()}${chatter(5)}`);
}

describe('a stored Codex question and the real, bounded transcript tail', () => {
  it('is NOT retired when the same rollout grew past the reader window and its tail holds neither call nor result', async () => {
    const w = await world();
    await writeFile(w.files.rollout, call('call_live'));
    await w.watch.sweep();
    expect(w.state.current?.toolUseId).toBe('call_live');

    await growPastTheWindow(w.files.rollout);
    await w.watch.sweep();
    await w.watch.sweep();

    expect(w.cleared).toEqual([]);
    expect(w.state.current?.toolUseId).toBe('call_live');
  });

  it('is retired by its own result, wherever it sits in the tail', async () => {
    const w = await world();
    await writeFile(w.files.rollout, call('call_live'));
    await w.watch.sweep();
    await growPastTheWindow(w.files.rollout);
    await appendFile(w.files.rollout, result('call_live'));

    await w.watch.sweep();

    expect(w.cleared).toEqual(['call_live']);
  });

  it('is retired when the ferret is on a different conversation file (the positive evidence)', async () => {
    const w = await world();
    await writeFile(w.files.rollout, call('call_live'));
    await w.watch.sweep();
    await writeFile(w.files.other, `${compacted()}${chatter(5)}`);
    w.state.file = w.files.other;
    w.state.conversation = 'conv-b';

    await w.watch.sweep();

    expect(w.cleared).toEqual(['call_live']);
    expect(w.state.current).toBeUndefined();
  });
});

/** A rollout as Codex writes it: the header record names the conversation (its native id), then the call. */
const header = (conversation: string): string =>
  line({ timestamp: ASKED, type: 'session_meta', payload: { id: conversation, cwd: '/synthetic' } });

/**
 * The same, through the production byte reader (`FileTranscriptReads`) over a REAL fenced root and real files: the handle's
 * token digests the PATHNAME, so a rename of one conversation is a new token while a different conversation is a new id.
 * Review of e0aa68a40b: a stored question is retired only when the NATIVE conversation id differs, and that id is stored
 * with the question, so a watcher made after a restart decides the same.
 */
async function realReaderWorld() {
  const parent = await mkdtemp('question-real-reader-');
  folders.push(parent);
  const { root } = await diskRoot(parent);
  const state = { name: 'rollout-a.jsonl', nowMs: Date.now(), current: undefined as Question | undefined };
  const at = (name: string): FencedPath => {
    const resolved = root.resolve(name);
    if (!resolved.ok) throw new Error('fixture path');
    return resolved.value as FencedPath;
  };
  const reads = new FileTranscriptReads(
    async (_ferret: FerretId) =>
      await openTranscriptBytes(root, at(state.name), 'codex', text => createHash('sha256').update(text).digest('hex')),
    {
      now: () => new Date(state.nowMs).toISOString(),
      pacing: { now: () => state.nowMs, yieldToLoop: async () => undefined },
      sleep: async () => undefined,
    },
  );
  const cleared: string[] = [];
  const tailed = async (limit: number) => await reads.tail('cody', limit).catch(() => undefined);
  const deps: QuestionWatchDeps = {
    roster: async () => [{ id: 'cody', harness: 'codex', state: 'working' }],
    harness: async () => undefined,
    current: async () => state.current,
    lastAnswered: async () => undefined,
    write: async () => undefined,
    clear: async (_ferret, id) => {
      cleared.push(id);
      state.current = undefined;
    },
    asked: async () => undefined,
    answered: async () => undefined,
    transcriptEvents: async (_ferret, limit) => {
      const read = await tailed(limit ?? QUESTION_TAIL_EVENTS);
      return read?.kind === 'read' ? read.events : 'unreadable';
    },
    conversation: async () => {
      const read = await tailed(QUESTION_TAIL_EVENTS);
      return read?.kind === 'read' ? read.conversation : undefined;
    },
    writeProjected: async (_ferret, pending, _askedAt, conversation) =>
      (state.current = {
        format: 1,
        toolUseId: pending.toolUseId,
        text: 'Which mode?',
        options: [{ label: 'Fast' }, { label: 'Slow' }],
        multiple: false,
        askedAt: ASKED,
        ...(conversation === undefined ? {} : { conversation }),
      }),
  };
  /** A watcher made now: what a daemon restart builds, holding nothing the old one remembered. */
  const watcher = () => new QuestionWatch(deps);
  /** The reader trusts a held file for 2 s (a switch is seen that much late): the test lets that moment pass. */
  const elapse = (): void => {
    state.nowMs += 5_000;
  };
  return { dir: join(parent, 'files'), state, cleared, watcher, elapse };
}

describe('a stored Codex question and the NATIVE conversation id (real byte reader, real files)', () => {
  it('stores the rollout’s own session id with the question when it is first seen', async () => {
    const w = await realReaderWorld();
    await writeFile(join(w.dir, 'rollout-a.jsonl'), `${header('conv-a')}${call('call_live')}`);

    await w.watcher().sweep();

    expect(w.state.current?.conversation).toBe('conv-a');
  });

  it('keeps the card when the SAME conversation is renamed (new path token, same session id), in the watcher that saw it and in a fresh one', async () => {
    const w = await realReaderWorld();
    await writeFile(join(w.dir, 'rollout-a.jsonl'), `${header('conv-a')}${call('call_live')}`);
    const original = w.watcher();
    await original.sweep();
    expect(w.state.current?.toolUseId).toBe('call_live');

    // Same inode under another name, grown past the reader window so its tail holds neither the call nor a result.
    await rename(join(w.dir, 'rollout-a.jsonl'), join(w.dir, 'rollout-renamed.jsonl'));
    w.state.name = 'rollout-renamed.jsonl';
    await growPastTheWindow(join(w.dir, 'rollout-renamed.jsonl'));

    await original.sweep();
    await original.sweep();
    await w.watcher().sweep();

    expect(w.cleared).toEqual([]);
    expect(w.state.current?.toolUseId).toBe('call_live');
  });

  it('retires the card when the ferret holds another conversation, in the watcher that saw it', async () => {
    const w = await realReaderWorld();
    await writeFile(join(w.dir, 'rollout-a.jsonl'), `${header('conv-a')}${call('call_live')}`);
    const original = w.watcher();
    await original.sweep();
    await writeFile(join(w.dir, 'rollout-b.jsonl'), `${header('conv-b')}${compacted()}${chatter(5)}`);
    w.state.name = 'rollout-b.jsonl';
    w.elapse();

    await original.sweep();

    expect(w.cleared).toEqual(['call_live']);
    expect(w.state.current).toBeUndefined();
  });

  it('retires the card when the ferret holds another conversation, in a FRESH watcher (after a restart)', async () => {
    const w = await realReaderWorld();
    await writeFile(join(w.dir, 'rollout-a.jsonl'), `${header('conv-a')}${call('call_live')}`);
    await w.watcher().sweep();
    await writeFile(join(w.dir, 'rollout-b.jsonl'), `${header('conv-b')}${compacted()}${chatter(5)}`);
    w.state.name = 'rollout-b.jsonl';
    w.elapse();

    const restarted = w.watcher();
    await restarted.sweep();

    expect(w.cleared).toEqual(['call_live']);
  });

  it('never retires by a switch a question that was stored without a conversation id (no migration)', async () => {
    const w = await realReaderWorld();
    await writeFile(join(w.dir, 'rollout-a.jsonl'), `${header('conv-a')}${call('call_live')}`);
    await w.watcher().sweep();
    const { conversation: _dropped, ...unmarked } = w.state.current as Question;
    w.state.current = unmarked;
    await writeFile(join(w.dir, 'rollout-b.jsonl'), `${header('conv-b')}${compacted()}${chatter(5)}`);
    w.state.name = 'rollout-b.jsonl';
    w.elapse();

    await w.watcher().sweep();

    expect(w.cleared).toEqual([]);
    expect(w.state.current?.toolUseId).toBe('call_live');
  });
});
