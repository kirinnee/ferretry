import { describe, expect, it } from 'bun:test';
import type { ConversionSummary } from '../../../../contract/index.ts';
import { moveCallFailure } from '../../../../app/features/move/call-failure.ts';
import {
  conversionFailure,
  conversionSentences,
  harnessProduct,
  otherHarness,
  refusedCause,
} from '../../../../app/features/move/conversion-model.ts';

const summary = (over: Partial<ConversionSummary> = {}): ConversionSummary => ({
  converter: 1,
  sourceHarness: 'claude',
  sourceVersion: '2.1.281',
  targetHarness: 'codex',
  targetVersion: '0.163.0',
  turns: 40,
  keptTurns: 40,
  omittedTurns: 0,
  cutNewest: false,
  messages: 80,
  nativeToolCalls: 0,
  toolCallsAsText: 0,
  attachments: 0,
  dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 },
  estimatedTokens: 1000,
  budgetTokens: 200000,
  ...over,
});

describe('harnessProduct', () => {
  it('names each CLI by its own product name', () => {
    expect(harnessProduct('claude-code')).toBe('Claude Code');
    expect(harnessProduct('codex')).toBe('Codex');
  });
  it('moves to the other CLI', () => {
    expect(otherHarness('claude-code')).toBe('codex');
    expect(otherHarness('codex')).toBe('claude-code');
  });
});
describe('conversionSentences', () => {
  it('says everything moves, in the singular and the plural', () => {
    expect(conversionSentences(summary(), 'gpt-5.5').headline).toBe('All 40 turns will move.');
    expect(conversionSentences(summary({ turns: 1, keptTurns: 1 }), 'gpt-5.5').headline).toBe('All 1 turn will move.');
  });

  it('says how much was left out to fit the window', () => {
    const said = conversionSentences(summary({ keptTurns: 12, omittedTurns: 28 }), 'gpt-5.5');
    expect(said.headline).toBe('12 of 40 turns will move to Codex (28 older turns left out to fit gpt-5.5’s window).');
    expect(conversionSentences(summary({ keptTurns: 39, omittedTurns: 1 }), 'm').headline).toContain(
      '1 older turn left',
    );
  });

  it('describes what is carried in a different shape, singular and plural', () => {
    const many = conversionSentences(summary({ nativeToolCalls: 9, toolCallsAsText: 31, attachments: 2 }), 'm');
    expect(many.carried).toEqual([
      '9 shell commands carry over as Codex commands.',
      '31 other tool calls become short text notes.',
      '2 attachments carry over as file references.',
    ]);
    const one = conversionSentences(summary({ nativeToolCalls: 1, toolCallsAsText: 1, attachments: 1 }), 'm');
    expect(one.carried).toEqual([
      '1 shell command carries over as a Codex command.',
      '1 other tool call becomes a short text note.',
      '1 attachment carries over as a file reference.',
    ]);
    expect(conversionSentences(summary(), 'm').carried).toEqual([]);
  });

  it('lists what is not carried, leaving out zero items', () => {
    expect(conversionSentences(summary(), 'm').notCarried).toBeNull();
    const said = conversionSentences(
      summary({ dropped: { reasoning: 14, sidechains: 3, internal: 57, compactions: 0 } }),
      'm',
    );
    expect(said.notCarried).toBe('Not carried: thinking (14), subagent work (3), harness notes (57).');
    expect(
      conversionSentences(summary({ dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 2 } }), 'm')
        .notCarried,
    ).toBe('Not carried: earlier summaries (2).');
  });

  it('warns about a shortened newest turn, and states the limit and versions in both directions', () => {
    expect(conversionSentences(summary({ cutNewest: true }), 'm').cutNewest).toBe(
      'The newest turn is too long and will be shortened.',
    );
    expect(conversionSentences(summary(), 'm').cutNewest).toBeNull();
    const said = conversionSentences(summary(), 'm');
    expect(said.note).toBe(
      'Tool calls other than shell commands become text, so Codex can read what happened but can’t re-run them. The Claude conversation stays on disk.',
    );
    expect(said.versions).toBe('Codex 0.163.0 · converted from Claude Code 2.1.281');
    const back = conversionSentences(
      summary({ sourceHarness: 'codex', targetHarness: 'claude', sourceVersion: undefined, targetVersion: '2.1.281' }),
      'm',
    );
    expect(back.versions).toBe('Claude Code 2.1.281 · converted from Codex');
    expect(back.note).toContain('Claude can read what happened');
    expect(back.note).toContain('The Codex conversation stays on disk.');
  });
});

describe('conversionFailure', () => {
  const inflight = {
    status: 'running',
    turn: 2,
    blockedBy: 'unknown',
    restartsWithCli: 0,
    items: [{ kind: 'process', verdict: 'unknown', title: 'A program is running', blocks: true }],
  };
  const refusal = (body?: unknown) => moveCallFailure({ message: 'refused', status: 409, code: 'move_refused', body });

  it('holds an in-flight refusal that names something to look at', () => {
    const said = conversionFailure(refusal({ error: 'refused', code: 'move_refused', inflight }));
    expect(said.kind).toBe('inflight');
    if (said.kind === 'inflight')
      expect(refusedCause(said.refusal)).toContain('can’t tell if what the agent is running');
  });
  it('shows any other refusal as its sentence', () => {
    expect(
      conversionFailure(moveCallFailure({ message: 'no good', status: 409, code: 'conversation_unresumable' })),
    ).toEqual({ kind: 'message', text: 'no good' });
    expect(conversionFailure(refusal({ inflight: { ...inflight, items: [] } }))).toEqual({
      kind: 'message',
      text: 'refused',
    });
    expect(conversionFailure(refusal({ nothing: true }))).toEqual({ kind: 'message', text: 'refused' });
    expect(conversionFailure(moveCallFailure('weird'))).toEqual({ kind: 'message', text: 'weird' });
  });
});
