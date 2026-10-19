import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type {
  ForkSessionOutcome,
  IFyApiClient,
  SessionTranscriptMessage,
  SessionTranscriptPage,
  SessionView,
} from '@ferretry/protocol';
import {
  DetailedFailure,
  forkThroughLatest,
  NothingToForkError,
  restartWithResume,
} from '../../../../src/features/session-actions/session-operations.ts';
import { sessionView } from '../../../support/sessions.ts';

/** Narrows away the `undefined` a `.find()` cannot promise is absent, failing out loud if it is. */
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};

const row = (byteOffset: number, text: string): SessionTranscriptMessage => ({
  point: { v: 1, byteOffset, blockIndex: 0 },
  role: 'user',
  text,
  selectionBinding: `bind-${byteOffset}`,
});

const page = (messages: readonly SessionTranscriptMessage[], nextCursor: string | null): SessionTranscriptPage => ({
  v: 1,
  sessionId: 'a1',
  messages,
  nextCursor,
});

const OUTCOME: ForkSessionOutcome = {
  session: { id: 'fork-1', name: 'Fork of Hadi', agent: 'claude', harness: 'claude', model: null, status: 'running' },
  plan: {
    v: 1,
    planId: 'plan-1',
    preparedAt: '2026-10-16T10:00:00.000Z',
    source: { sessionId: 'a1', cutMessagePoint: { v: 1, byteOffset: 1 } },
    target: { agent: 'claude', harness: 'claude', model: null, effort: null, contextWindow: 200_000 },
    notCarried: [],
  },
};

interface Call {
  readonly name: 'messages' | 'fork' | 'rename' | 'migrate';
  readonly args: readonly unknown[];
}

interface Scripted {
  readonly calls: Call[];
  pages: SessionTranscriptPage[];
  outcome: ForkSessionOutcome | Error;
  renamed: SessionView;
}

const scripted = (overrides: Partial<Scripted> = {}): Scripted => ({
  calls: [],
  pages: [page([row(1, 'hello')], null)],
  outcome: OUTCOME,
  renamed: sessionView('fork-1'),
  ...overrides,
});

const client = (state: Scripted) => {
  let served = 0;
  return {
    messages: async (id: string, cursor?: string, limit?: number) => {
      state.calls.push({ name: 'messages', args: [id, cursor, limit] });
      const answer = state.pages[served] ?? page([], null);
      served += 1;
      return answer;
    },
    fork: async (id: string, input: unknown, requestId?: string) => {
      state.calls.push({ name: 'fork', args: [id, input, requestId] });
      if (state.outcome instanceof Error) throw state.outcome;
      return state.outcome;
    },
    rename: async (id: string, name: string | undefined, teammate: string | undefined) => {
      state.calls.push({ name: 'rename', args: [id, name, teammate] });
      return state.renamed;
    },
    migrate: async (
      id: string,
      agent: string,
      model: string | undefined,
      allowContextDowngrade: boolean | undefined,
      requestId: string | undefined,
    ) => {
      state.calls.push({ name: 'migrate', args: [id, agent, model, allowContextDowngrade, requestId] });
      return state.renamed;
    },
  };
};

const view = sessionView('a1', { config: { agent: 'nero' } });

describe('forkThroughLatest', () => {
  it('forks through the last message of a single page, with no rename when no teammate is given', async () => {
    const state = scripted();
    const fake = client(state);
    const outcome = await forkThroughLatest(fake, view, undefined, 'req-1');
    expect(outcome).toEqual(OUTCOME);
    expect(state.calls).toEqual([
      { name: 'messages', args: ['a1', undefined, 1000] },
      {
        name: 'fork',
        args: [
          'a1',
          { through: { v: 1, byteOffset: 1, blockIndex: 0 }, selectionBinding: 'bind-1', agent: 'nero' },
          'req-1',
        ],
      },
    ]);
  });

  it('walks forward with the cursor the daemon hands back, keeping only the latest row across pages', async () => {
    const state = scripted({
      pages: [page([row(1, 'a'), row(2, 'b')], 'cursor-1'), page([row(3, 'c')], null)],
    });
    const fake = client(state);
    await forkThroughLatest(fake, view, undefined, 'req-1');
    expect(state.calls.filter(call => call.name === 'messages').map(call => call.args)).toEqual([
      ['a1', undefined, 1000],
      ['a1', 'cursor-1', 1000],
    ]);
    const forkCall = state.calls.find(call => call.name === 'fork');
    expect((must(forkCall, 'fork call').args[1] as { through: { byteOffset: number } }).through.byteOffset).toBe(3);
  });

  it('keeps the previous page’s last row when a later page answers empty, rather than losing it', async () => {
    const state = scripted({
      pages: [page([row(1, 'a')], 'cursor-1'), page([], null)],
    });
    const fake = client(state);
    await forkThroughLatest(fake, view, undefined, 'req-1');
    const forkCall = state.calls.find(call => call.name === 'fork');
    expect((must(forkCall, 'fork call').args[1] as { through: { byteOffset: number } }).through.byteOffset).toBe(1);
  });

  it('stops after 50 pages even when the daemon never says it has reached the end', async () => {
    const pages: SessionTranscriptPage[] = [];
    for (let index = 0; index < 60; index += 1) pages.push(page([row(index, `m${index}`)], 'more'));
    const state = scripted({ pages });
    const fake = client(state);
    await forkThroughLatest(fake, view, undefined, 'req-1');
    expect(state.calls.filter(call => call.name === 'messages')).toHaveLength(50);
    const forkCall = state.calls.find(call => call.name === 'fork');
    expect((must(forkCall, 'fork call').args[1] as { through: { byteOffset: number } }).through.byteOffset).toBe(49);
  });

  it('throws NothingToForkError, and never calls fork, when there is no message on any page', async () => {
    const state = scripted({ pages: [page([], null)] });
    const fake = client(state);
    await expect(forkThroughLatest(fake, view, undefined, 'req-1')).rejects.toBeInstanceOf(NothingToForkError);
    await expect(forkThroughLatest(fake, view, undefined, 'req-1')).rejects.toThrow(
      'there is no message to fork from yet — send this ferret something first',
    );
    expect(state.calls.some(call => call.name === 'fork')).toBe(false);
  });

  it('renames the fork when a teammate name is given, trimmed and lower-cased', async () => {
    const state = scripted();
    const fake = client(state);
    const outcome = await forkThroughLatest(fake, view, '  NERO-2  ', 'req-1');
    expect(state.calls.at(-1)).toEqual({ name: 'rename', args: [outcome.session.id, undefined, 'nero-2'] });
  });

  it('does not rename when the teammate name is empty or only whitespace', async () => {
    const state = scripted();
    const fake = client(state);
    await forkThroughLatest(fake, view, '   ', 'req-1');
    expect(state.calls.some(call => call.name === 'rename')).toBe(false);
  });

  it('propagates a refusal from the fork route itself', async () => {
    const state = scripted({ outcome: new Error('nothing to transfer') });
    const fake = client(state);
    await expect(forkThroughLatest(fake, view, undefined, 'req-1')).rejects.toThrow('nothing to transfer');
  });
});

describe('restartWithResume', () => {
  it('migrates the ferret on its own login, with no model change and no context downgrade', async () => {
    const state = scripted();
    const fake = client(state);
    const result = await restartWithResume(fake, view, 'req-2');
    expect(result).toEqual(state.renamed);
    expect(state.calls).toEqual([{ name: 'migrate', args: ['a1', 'nero', undefined, false, 'req-2'] }]);
  });
});

describe('restartWithResume — a refusal because ps failed', () => {
  const refusal = (message: string, code = 'migration_refused'): FyHttpError => new FyHttpError(message, 409, code);
  const failing = (error: Error): Pick<IFyApiClient, 'migrate'> => ({
    migrate: async () => {
      throw error;
    },
  });
  const raw =
    'refused: the process table could not be read: ps exited 1: ps: etimes: keyword not found\nin-flight inventory — status running';

  it('says plainly that nothing was restarted and keeps the daemon’s words as the detail', async () => {
    const thrown = await restartWithResume(failing(refusal(raw)), view, 'req-3').catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DetailedFailure);
    expect((thrown as DetailedFailure).message).toBe(
      "Couldn't check the agent's processes on this machine (ps failed). Nothing was restarted.",
    );
    expect((thrown as DetailedFailure).detail).toBe(raw);
  });

  it('leaves a refusal about real in-flight work, and every other failure, exactly as the daemon said it', async () => {
    const inflight = refusal('refused: in-flight work is destructive_to_interrupt');
    const other = refusal(raw, 'session_migrate_failed');
    const plain = new Error('socket closed');
    for (const error of [inflight, other, plain])
      expect(await restartWithResume(failing(error), view, 'req-4').catch((reason: unknown) => reason)).toBe(error);
  });
});
