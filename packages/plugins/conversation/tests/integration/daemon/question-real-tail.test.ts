import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { Instant } from '@ferretry/std';
import type { Question } from '../../../contract/index.ts';
import { CodexTranscriptParser } from '../../../daemon/reader/lib/transcript/codex.ts';
import { tailTranscriptEvents } from '../../../daemon/reader/lib/session/reader.ts';
import { QUESTION_TAIL_EVENTS, QuestionWatch, type QuestionWatchDeps } from '../../../daemon/questions/lib/watch.ts';
import { appendFile, mkdtemp, newSource, rm, truncate, writeFile } from '../../support/disk-files.ts';

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
  const state = { file: files.rollout, current: undefined as Question | undefined };
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
    transcriptFile: async () => state.file,
    writeProjected: async (_ferret, pending) =>
      (state.current = {
        format: 1,
        toolUseId: pending.toolUseId,
        text: 'Which mode?',
        options: [{ label: 'Fast' }, { label: 'Slow' }],
        multiple: false,
        askedAt: ASKED,
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

    await w.watch.sweep();

    expect(w.cleared).toEqual(['call_live']);
    expect(w.state.current).toBeUndefined();
  });
});
