import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { AskedQuestionFile, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import type { Question } from '../../../../contract/index.ts';
import { parseAskedQuestion } from '../../../../daemon/questions/lib/asked.ts';
import {
  QuestionWatch,
  type QuestionWatchDeps,
  type WatchedFerret,
  type WatchedHarness,
} from '../../../../daemon/questions/lib/watch.ts';
import { fixtureTexts } from '../../../support/fixtures.ts';

/** The live `PreToolUse` payload of Claude Code 2.1.281 (`tests/fixtures/question-asked/`). */
const fixture = await fixtureTexts(join(import.meta.dir, '../../../fixtures/question-asked'));
const PAYLOAD = fixture('claude-2.1.281-pretooluse.json');
const TRANSCRIPT = '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl';
const TOOL_USE_ID = 'toolu_01T4KnfY1in2GTL7P9wUmRtt';
const WRITTEN = '2026-10-30T04:33:36.000Z' as Instant;
const entry = (at: string, text = 'hello'): TranscriptEntry => ({ id: at, at: at as Instant, role: 'assistant', text });
/** An entry that carries the call (`toolCalls`) or its result (`toolResults`) by id, as the Claude reader parses one. */
const tool = (at: string, field: 'toolCalls' | 'toolResults', id = TOOL_USE_ID): TranscriptEntry => ({
  id: `${field}:${at}`,
  at: at as Instant,
  role: 'tool',
  data: { [field]: [id] },
});

/** One watch over a fake world: the hook file, the transcript, `question.json` and the events published. */
function world(options: { ferrets?: readonly WatchedFerret[] } = {}) {
  const state = {
    file: { payload: PAYLOAD, writtenAt: WRITTEN, transcript: TRANSCRIPT } as AskedQuestionFile | undefined,
    entries: [entry('2026-10-30T04:00:00.000Z')] as readonly TranscriptEntry[] | 'unreadable',
    question: undefined as Question | undefined,
    /** The tool id `question-answered.json` names. */
    stamp: undefined as string | undefined,
    stampReadable: true,
  };
  const events: string[] = [];
  const writes: string[] = [];
  const harness: WatchedHarness = {
    askedQuestion: async () => state.file,
    transcript: {
      read: async () => {
        if (state.entries === 'unreadable') throw new Error('no transcript');
        return state.entries;
      },
    },
  };
  const deps: QuestionWatchDeps = {
    roster: async () => options.ferrets ?? [{ id: 'fern', harness: 'claude-code', state: 'working' }],
    harness: async () => harness,
    current: async () => state.question,
    lastAnswered: async () => {
      if (!state.stampReadable) throw new Error('the stamp is unreadable');
      return state.stamp;
    },
    write: async (_ferret, payload, askedAt, transcript) => {
      writes.push(payload);
      const parsed = parseAskedQuestion(payload, Date.parse(askedAt), transcript);
      const first = parsed?.questions[0];
      if (parsed === undefined || first === undefined || transcript === undefined) {
        state.question = undefined;
        return undefined;
      }
      state.question = {
        format: 1,
        toolUseId: parsed.toolUseId,
        text: first.question,
        options: first.options.map(({ label }) => ({ label })),
        multiple: first.multiple,
        askedAt,
        transcript,
      };
      return state.question;
    },
    clear: async (_ferret, toolUseId) => {
      if (state.question?.toolUseId === toolUseId) state.question = undefined;
    },
    asked: async (ferret, toolUseId) => void events.push(`asked ${ferret} ${toolUseId}`),
    answered: async (ferret, toolUseId) => void events.push(`answered ${ferret} ${toolUseId}`),
  };
  return { state, events, writes, watch: new QuestionWatch(deps) };
}

describe('the question watch: the hook’s file becomes question.json', () => {
  it('stores the recorded question, publishes QuestionAsked once, and does not store the same payload again', async () => {
    const w = world();
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(TOOL_USE_ID);
    expect(w.state.question?.transcript).toBe(TRANSCRIPT);
    expect(w.events).toEqual([`asked fern ${TOOL_USE_ID}`]);
    await w.watch.sweep();
    await w.watch.sweep();
    expect(w.writes).toHaveLength(1);
    expect(w.events).toHaveLength(1);
  });

  it('retires the question when the transcript names its call, publishes QuestionAnswered and never stores the stale file again', async () => {
    const w = world();
    await w.watch.sweep();
    w.state.entries = [entry('2026-10-30T04:00:00.000Z'), tool('2026-10-30T04:00:01.000Z', 'toolResults')];
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events).toEqual([`asked fern ${TOOL_USE_ID}`, `answered fern ${TOOL_USE_ID}`]);
    await w.watch.sweep();
    expect(w.writes).toHaveLength(1);
  });

  it('does not take an id mentioned in prose for the call: only the entry’s tool identity names it', async () => {
    const w = world();
    w.state.entries = [entry('2026-10-30T04:00:00.000Z', `I am about to call ${TOOL_USE_ID} for you`)];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(TOOL_USE_ID);
  });

  it('does not take another call’s id for this one', async () => {
    const w = world();
    w.state.entries = [tool('2026-10-30T04:00:00.000Z', 'toolResults', 'toolu_other')];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(TOOL_USE_ID);
  });

  it('never shows a payload whose tool id an answer was stamped for, whatever the transcript says', async () => {
    const w = world();
    w.state.stamp = TOOL_USE_ID;
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.writes).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('clears a stored question its answer was stamped for (a crash between the stamp and the clear)', async () => {
    const w = world();
    await w.watch.sweep();
    w.state.stamp = TOOL_USE_ID;
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events.at(-1)).toBe(`answered fern ${TOOL_USE_ID}`);
  });

  it('a stamp for an earlier question does not hide a new one', async () => {
    const w = world();
    w.state.stamp = 'toolu_older';
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(TOOL_USE_ID);
  });

  it('decides nothing while the answered stamp cannot be read', async () => {
    const w = world();
    w.state.stampReadable = false;
    await w.watch.sweep();
    expect(w.writes).toEqual([]);
    w.state.stampReadable = true;
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(TOOL_USE_ID);
  });

  it('retires the question when any event is newer than it was asked', async () => {
    const w = world();
    await w.watch.sweep();
    w.state.entries = [entry('2099-01-01T00:00:00.000Z')];
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events.at(-1)).toBe(`answered fern ${TOOL_USE_ID}`);
  });

  it('never shows a question the transcript already names (a daemon restart meeting an answered form’s file)', async () => {
    const w = world();
    w.state.entries = [tool('2026-10-30T04:00:00.000Z', 'toolCalls')];
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.writes).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('decides nothing while the transcript cannot be read, and shows the question once it can', async () => {
    const w = world();
    w.state.entries = 'unreadable';
    await w.watch.sweep();
    expect(w.writes).toEqual([]);
    w.state.entries = [entry('2026-10-30T04:00:00.000Z')];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(TOOL_USE_ID);
  });

  it('a payload the writer cannot store whole clears the earlier question and publishes nothing', async () => {
    const w = world();
    await w.watch.sweep();
    w.state.file = { payload: '{"not":"a hook payload"}', writtenAt: WRITTEN, transcript: TRANSCRIPT };
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events).toEqual([`asked fern ${TOOL_USE_ID}`]);
  });

  it('looks only at a Claude Code ferret that is working or idle', async () => {
    const stopped = world({ ferrets: [{ id: 'fern', harness: 'claude-code', state: 'stopped' }] });
    await stopped.watch.sweep();
    const codex = world({ ferrets: [{ id: 'fern', harness: 'codex', state: 'working' }] });
    await codex.watch.sweep();
    const idle = world({ ferrets: [{ id: 'fern', harness: 'claude-code', state: 'idle' }] });
    await idle.watch.sweep();
    expect(stopped.writes).toEqual([]);
    expect(codex.writes).toEqual([]);
    expect(idle.writes).toHaveLength(1);
  });

  it('a ferret with no hook file shows nothing, and a failing look does not stop the sweep', async () => {
    const w = world({
      ferrets: [
        { id: 'a', harness: 'claude-code', state: 'working' },
        { id: 'b', harness: 'claude-code', state: 'working' },
      ],
    });
    w.state.file = undefined;
    await w.watch.sweep();
    expect(w.writes).toEqual([]);
  });

  it('forget lets a revived ferret’s file be read afresh', async () => {
    const w = world();
    await w.watch.sweep();
    w.state.question = undefined;
    w.watch.forget('fern');
    await w.watch.sweep();
    expect(w.writes).toHaveLength(2);
  });
});
